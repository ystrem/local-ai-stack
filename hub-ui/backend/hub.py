"""HUB backend — multi-stroj ovládací panel (FÁZE 2/3: režimy strojů + cluster AUTO/MANUAL).

- machines.yaml: {id, name, url, agent_url?} — zbytek se načte z /capabilities na stroji
- Probing: periodicky GET {url}/capabilities → cache stavu (GPU, služby, running)
- match(model, machine): doporučovač — gpu_archs průnik → volná VRAM → multi_gpu
- Runtime správa strojů: POST/DELETE /machines s persistencí do machines.yaml
- Assignment: {service: {primary, fallback}} — resolve() vrátí efektivní stroj
  (primární down → fallback). Pořád žádný AUTO-failover: fallback je ruční volba.
- Cluster mode: auto | manual (centrální přepínač; proxy/auto-návrat fungují jen v AUTO)
- Režimy strojů: media/coding — výhradní skupiny služeb per stroj (mode pole ve services.yaml)
"""
import asyncio
import logging
import os
import re
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
import yaml
from fastapi import APIRouter, HTTPException

log = logging.getLogger("comfyui-webapp.hub")  # noqa: F821

MACHINES_FILE = Path(os.environ.get("HUB_MACHINES_FILE", "machines.yaml"))
ASSIGNMENTS_FILE = Path(os.environ.get("HUB_ASSIGNMENTS_FILE", "hub_assignments.yaml"))
PROBE_INTERVAL = float(os.environ.get("HUB_PROBE_INTERVAL", "5"))
PROBE_TIMEOUT = float(os.environ.get("HUB_PROBE_TIMEOUT", "4"))

hub_router = APIRouter(prefix="/api/hub", tags=["hub"])

# machine_id → {"caps": dict|None, "last_ok": float, "last_probe": float, "down_since": float|None}
_probed: dict[str, dict] = {}
_probe_task: asyncio.Task | None = None


def load_machines() -> list[dict]:
    if not MACHINES_FILE.exists():
        return []
    cfg = yaml.safe_load(MACHINES_FILE.read_text()) or {}
    machines = []
    for m in cfg.get("machines", []):
        if not m.get("id") or not m.get("url"):
            continue
        machines.append({"id": m["id"], "name": m.get("name", m["id"]),
                         "url": m["url"].rstrip("/"),
                         "agent_url": (m.get("agent_url") or "").rstrip("/") or None})
    return machines


def save_machines(machines: list[dict]) -> None:
    """Persistuje stroje do machines.yaml (stejný formát jaký čte load_machines)."""
    data = {"machines": [{"id": m["id"], "name": m["name"], "url": m["url"],
                          **({"agent_url": m["agent_url"]} if m.get("agent_url") else {})}
                         for m in machines]}
    MACHINES_FILE.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))


def machine_agent_url(mid: str) -> str | None:
    """Vrátí agent_url stroje (hub-agent sidecar), pokud je nastavené."""
    for m in load_machines():
        if m["id"] == mid:
            return m.get("agent_url")
    raise KeyError(mid)


# ── Runtime správa strojů (add via IP za běhu) ────────────

def _validate_url(url: str) -> str:
    p = urlparse(url.strip())
    if p.scheme not in ("http", "https") or not p.hostname:
        raise HTTPException(400, f"url musí být http(s)://host[:port], dostáno „{url}“")
    return f"{p.scheme}://{p.netloc}"


def _unique_id(base: str, taken: set[str]) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-") or "machine"
    mid, n = slug, 2
    while mid in taken:
        mid = f"{slug}-{n}"
        n += 1
    return mid


async def add_machine(url: str, name: str = "", mid: str = "") -> dict:
    """Přidá stroj, okamžitě probene, persistuje. Vrací uloženou položku."""
    url = _validate_url(url)
    machines = load_machines()
    taken_ids = {m["id"] for m in machines}
    taken_urls = {m["url"] for m in machines}
    if url in taken_urls:
        raise HTTPException(409, f"stroj s url {url} už existuje")
    if mid:
        mid = _unique_id(mid, set())  # normalizace slugu
        if mid in taken_ids:
            raise HTTPException(409, f"stroj s id „{mid}“ už existuje")
    else:
        host = urlparse(url).hostname or "machine"
        mid = _unique_id(host, taken_ids)
    machine = {"id": mid, "name": name.strip() or mid, "url": url}
    machines.append(machine)
    save_machines(machines)
    await _probe_once(machine)  # ať UI vidí capabilities hned, ne až po intervalu
    return machine


def remove_machine(mid: str) -> None:
    """Smaže stroj z YAML, probed cache i assignmentů (fallback případně povýší)."""
    machines = load_machines()
    remaining = [m for m in machines if m["id"] != mid]
    if len(remaining) == len(machines):
        raise HTTPException(404, f"machine {mid} not in machines.yaml")
    save_machines(remaining)
    _probed.pop(mid, None)
    changed = False
    for svc, a in list(_assignments.items()):
        if a.get("primary") == mid:
            a["primary"] = a.get("fallback")  # fallback povýší na primár
            a["fallback"] = None
            changed = True
        elif a.get("fallback") == mid:
            a["fallback"] = None
            changed = True
    if changed:
        _save_assignments()


# ── Legacy fallback (stroje se starým api-wrapperem bez /capabilities) ──

def _arch_from_gpu_name(name: str) -> str | None:
    """Odvodí GPU arch z názvu karty pro legacy stroje (nemají cc → arch tabulku)."""
    n = (name or "").lower()
    if "p40" in n or "p4000" in n or "p6000" in n:
        return "pascal"
    if re.search(r"\b(30[5-9]0|3060|3070|3080|3090)\b", n) or "a100" in n or "a40" in n:
        return "ampere"
    if re.search(r"\b50[35-9]0\b", n):
        return "blackwell"
    return None


def _legacy_caps(gpus_payload: dict, health: dict) -> dict:
    """Složí capabilities ve formátu /capabilities z legacy /gpus + /health."""
    gpus = []
    for g in (gpus_payload.get("devices") or []):
        total = int(g.get("vram_total_mb") or 0)
        free = int(g.get("vram_free_mb") or 0)
        gpus.append({
            "index": g.get("index"),
            "name": g.get("name") or f"GPU {g.get('index')}",
            "vram_total_mb": total,
            "vram_free_mb": free,
            "vram_used_mb": max(total - free, 0),
            "util_pct": 0,  # legacy neposílá util
            "temp_c": None,
            "cc": None,
            "arch": _arch_from_gpu_name(g.get("name") or ""),
        })
    services = []
    if isinstance(health, dict):
        services.append({"id": "comfyui", "port": None,
                         "running": health.get("comfyui") == "running"})
    return {
        "machine": {"hostname": health.get("gpu", {}).get("name") or "legacy",
                    "ram_mb": 0, "cpu_cores": 0},
        "gpus": gpus,
        "services": services,
        "legacy": True,
    }


async def _probe_once(machine: dict) -> None:
    mid = machine["id"]
    now = time.time()
    # Prefer agent_url (hub-agent per-stroj s toggles/GPU locks) — falls back to url
    # (legacy api-wrapper) if agent_url is not configured.
    probe_base = machine.get("agent_url") or machine["url"]
    try:
        async with httpx.AsyncClient(timeout=PROBE_TIMEOUT) as client:
            r = await client.get(f"{probe_base}/capabilities")
            if r.status_code == 404:
                # starý api-wrapper bez /capabilities → legacy /gpus + /health
                gr = await client.get(f"{machine['url']}/gpus")
                hr = await client.get(f"{machine['url']}/health")
                gr.raise_for_status()
                hr.raise_for_status()
                caps = _legacy_caps(gr.json(), hr.json())
            else:
                r.raise_for_status()
                caps = r.json()
    except Exception as e:
        st = _probed.setdefault(mid, {"caps": None, "last_ok": 0.0,
                                      "last_probe": now, "down_since": now})
        st["last_probe"] = now
        if st["down_since"] is None:
            st["down_since"] = now
        log.warning("probe %s failed: %s", mid, e)
        return
    st = _probed.setdefault(mid, {"caps": None, "last_ok": 0.0,
                                  "last_probe": now, "down_since": None})
    st["caps"] = caps
    st["last_ok"] = now
    st["last_probe"] = now
    st["down_since"] = None


async def _probe_loop() -> None:
    while True:
        machines = load_machines()
        await asyncio.gather(*(_probe_once(m) for m in machines),
                             return_exceptions=True)
        await asyncio.sleep(PROBE_INTERVAL)


def start_probing() -> None:
    global _probe_task
    if _probe_task is None or _probe_task.done():
        _probe_task = asyncio.create_task(_probe_loop())


async def stop_probing() -> None:
    global _probe_task
    if _probe_task:
        _probe_task.cancel()
        try:
            await _probe_task
        except asyncio.CancelledError:
            pass
        _probe_task = None


# ── match() — doporučovač (čistá funkce, unit-testovatelná) ──

def match(model: dict, machine: dict) -> dict:
    """Ověří, jestli stroj zvládne model. Vrací {"ok": bool, "reason": str, "free_mb": int}.

    model: položka z model_registry (gpu_archs, vram_mb, multi_gpu)
    machine: /capabilities payload (gpus s arch, vram_free_mb)
    """
    gpus = (machine.get("gpus") or []) if isinstance(machine, dict) else []
    if not gpus:
        return {"ok": False, "reason": "stroj bez GPU dat", "free_mb": 0}

    model_archs = set(model.get("gpu_archs") or [])
    machine_archs = {g.get("arch") for g in gpus}
    if model_archs and not (model_archs & machine_archs):
        return {"ok": False,
                "reason": f"arch neumí ({'/'.join(sorted(machine_archs))}, model chce {'/'.join(sorted(model_archs))})",
                "free_mb": 0}

    need_mb = int(model.get("vram_mb") or 0)
    free = [int(g.get("vram_free_mb") or 0) for g in gpus]
    if model.get("multi_gpu"):
        # rozložitelné na 2 karty — stačí součet dvou největších
        biggest = sorted(free, reverse=True)[:2]
        total = sum(biggest)
        if total < need_mb:
            return {"ok": False,
                    "reason": f"{total // 1024} GB volno na 2 GPU, model chce {need_mb // 1024} GB",
                    "free_mb": total}
        return {"ok": True, "reason": f"multi-GPU {biggest[0] // 1024}+{biggest[1] // 1024} GB",
                "free_mb": total}

    best = max(free)
    if best < need_mb:
        return {"ok": False,
                "reason": f"{best // 1024} GB volno nestačí, model chce {need_mb // 1024} GB",
                "free_mb": best}
    return {"ok": True, "reason": f"{best // 1024} GB volno", "free_mb": best}


def _machine_status(mid: str) -> dict:
    st = _probed.get(mid, {})
    caps = st.get("caps")
    down_since = st.get("down_since")
    if not caps:
        status = "down"
    else:
        services = caps.get("services") or []
        status = "online" if all(s.get("running", False) for s in services) or not services \
            else "degraded"
    return {
        "status": status,
        "down_since": down_since,
        "last_ok": st.get("last_ok"),
        "last_probe": st.get("last_probe"),
        "caps": caps,
    }


# ── API ───────────────────────────────────────────────────

@hub_router.get("/machines")
async def machines():
    out = []
    for m in load_machines():
        st = _machine_status(m["id"])
        out.append({**m, "status": st["status"], "down_since": st["down_since"],
                    "last_ok": st["last_ok"], "last_probe": st["last_probe"],
                    "caps": st["caps"]})
    return {"machines": out}


@hub_router.get("/capabilities/{mid}")
async def machine_capabilities(mid: str):
    for m in load_machines():
        if m["id"] == mid:
            st = _machine_status(mid)
            if not st["caps"]:
                raise HTTPException(503, f"machine {mid} is down (no capabilities)")
            return st["caps"]
    raise HTTPException(404, f"machine {mid} not in machines.yaml")


@hub_router.get("/models-for/{mid}")
async def models_for(mid: str):
    """Kompatibilita model × stroj: které modely pojedou na daném stroji (match() per model)."""
    st = _machine_status(mid)
    if not st["caps"]:
        raise HTTPException(503, f"machine {mid} is down (no capabilities)")
    from app import _model_meta
    out = []
    for model_id, cfg in _model_meta.items():
        model = {"gpu_archs": cfg.get("gpu_archs", []), "vram_mb": cfg.get("vram_mb", 0),
                 "multi_gpu": cfg.get("multi_gpu", False)}
        res = match(model, st["caps"])
        out.append({"id": model_id, "kind": cfg.get("kind"), "name": cfg.get("name", model_id),
                    "ok": res["ok"], "reason": res["reason"], "free_mb": res["free_mb"]})
    out.sort(key=lambda x: (not x["ok"], x["kind"], x["name"]))
    return {"machine": mid, "status": st["status"], "models": out}


@hub_router.get("/recommend/{model_id}")
async def recommend(model_id: str):
    """Seřazený seznam strojů pro model: schopné první (nejvíc volné VRAM), s důvody."""
    # registry žije v backendu (server.py); wrapper má její cache z /models
    from app import _model_meta
    cfg = _model_meta.get(model_id)
    if cfg is None:
        raise HTTPException(404, f"model {model_id} not in registry cache")
    model = {"gpu_archs": cfg.get("gpu_archs", []), "vram_mb": cfg.get("vram_mb", 0),
             "multi_gpu": cfg.get("multi_gpu", False)}
    out = []
    for m in load_machines():
        st = _machine_status(m["id"])
        if not st["caps"]:
            out.append({**m, "ok": False, "reason": "stroj down", "free_mb": 0,
                        "status": "down"})
            continue
        res = match(model, st["caps"])
        out.append({**m, **res, "status": st["status"]})
    # schopné první, dle volné VRAM sestupně; neschopné za nimi
    out.sort(key=lambda x: (not x["ok"], -x.get("free_mb", 0)))
    return {"model": model_id, "machines": out}


# ── Assignment: service → {primary, fallback} ─────────────

_assignments: dict[str, dict] = {}  # service_kind → {"primary": id|None, "fallback": id|None}


def _load_assignments() -> None:
    if not ASSIGNMENTS_FILE.is_file():
        return  # chybí/neadresář → nic nenačítat (startup nesmí spadnout)
    try:
        cfg = yaml.safe_load(ASSIGNMENTS_FILE.read_text()) or {}
    except yaml.YAMLError as e:
        log.warning("assignments file %s unparseable: %s", ASSIGNMENTS_FILE, e)
        return
    for svc, a in (cfg.get("assignments") or {}).items():
        _assignments[svc] = {"primary": a.get("primary"),
                             "fallback": a.get("fallback")}


def _save_assignments() -> None:
    data = {"assignments": {svc: dict(a) for svc, a in _assignments.items()}}
    ASSIGNMENTS_FILE.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))


def machine_base_url(mid: str) -> str:
    """Vrátí base URL stroje z machines.yaml; neznámé id → KeyError (caller mapuje na 400)."""
    for m in load_machines():
        if m["id"] == mid:
            return m["url"]
    raise KeyError(mid)


# ── Desired state (dashboard: co kde má běžet) ────────────

DESIRED_FILE = Path(os.environ.get("HUB_DESIRED_FILE", "/tmp/hub_desired.yaml"))
_desired: dict[str, dict] = {}  # service_id → {machine, gpu, enabled}


def load_desired() -> None:
    global _desired
    if not DESIRED_FILE.is_file():
        _desired = {}
        return
    try:
        cfg = yaml.safe_load(DESIRED_FILE.read_text()) or {}
    except yaml.YAMLError as e:
        log.warning("desired file %s unparseable: %s", DESIRED_FILE, e)
        _desired = {}
        return
    _desired = {sid: dict(a) for sid, a in (cfg.get("services") or {}).items()}


def save_desired() -> None:
    DESIRED_FILE.parent.mkdir(parents=True, exist_ok=True)
    data = {"services": {sid: dict(a) for sid, a in _desired.items()}}
    DESIRED_FILE.write_text(yaml.safe_dump(data, sort_keys=False, allow_unicode=True))


def set_desired(service_id: str, machine: str | None, gpu: int | str | None, enabled: bool) -> dict:
    _desired[service_id] = {"machine": machine, "gpu": gpu, "enabled": enabled}
    save_desired()
    return dict(_desired[service_id])


def drift() -> dict[str, dict]:
    """Služby, kde desired ≠ actual (running stav z posledního probe)."""
    out = {}
    for sid, want in _desired.items():
        mid = want.get("machine")
        if not mid:
            continue
        st = _probed.get(mid, {})
        caps = st.get("caps") or {}
        svc = next((s for s in (caps.get("services") or []) if s.get("id") == sid), None)
        actual_running = bool(svc and svc.get("running"))
        want_running = bool(want.get("enabled"))
        if actual_running != want_running:
            out[sid] = {"machine": mid, "desired": want_running, "actual": actual_running}
    return out


def _machine_ids() -> set[str]:
    return {m["id"] for m in load_machines()}


def _is_up(mid: str) -> bool:
    return bool(_machine_status(mid)["caps"])


def resolve(service: str) -> dict:
    """Efektivní stroj pro službu: primární up → primární; jinak fallback, pokud up."""
    a = _assignments.get(service) or {}
    primary, fallback = a.get("primary"), a.get("fallback")
    ids = _machine_ids()
    chosen, reason = None, "bez assignmentu"
    if primary and primary in ids and _is_up(primary):
        chosen = primary
        reason = "primární"
    elif fallback and fallback in ids and _is_up(fallback):
        chosen = fallback
        reason = f"fallback ({primary or 'žádný primár'} je down/není nastaven)"
    elif fallback and fallback in ids:
        reason = "fallback down"
    elif primary:
        reason = "primární down"
    return {"service": service, "primary": primary, "fallback": fallback,
            "machine": chosen, "reason": reason}


@hub_router.post("/assignment")
async def set_assignment(payload: dict):
    service = str(payload.get("service", "")).strip()
    primary = str(payload.get("machine") or payload.get("primary") or "").strip()
    fallback = str(payload.get("fallback") or "").strip()
    if not service:
        raise HTTPException(400, "service is required")
    known = _machine_ids()
    for label, mid in (("machine", primary), ("fallback", fallback)):
        if mid and mid not in known:
            raise HTTPException(400, f"unknown {label} {mid}")
    if fallback and fallback == primary and primary:
        raise HTTPException(400, "fallback nesmí být stejný jako primární")
    if not primary and not fallback:
        _assignments.pop(service, None)
    else:
        _assignments[service] = {"primary": primary or None, "fallback": fallback or None}
    _save_assignments()
    return {"status": "ok", **resolve(service)}


@hub_router.get("/assignment")
async def get_assignment(service: str):
    return resolve(service)


@hub_router.delete("/assignment")
async def delete_assignment(service: str):
    _assignments.pop(service, None)
    _save_assignments()
    return {"status": "ok", "service": service}


@hub_router.get("/assignments")
async def all_assignments():
    return {"assignments": {svc: resolve(svc) for svc in sorted(_assignments)}}


# ── Runtime správa strojů (add via IP za běhu) ────────────

@hub_router.post("/machines")
async def create_machine(payload: dict):
    machine = await add_machine(
        url=str(payload.get("url", "")),
        name=str(payload.get("name") or ""),
        mid=str(payload.get("id") or ""),
    )
    st = _machine_status(machine["id"])
    return {"status": "ok", "machine": {**machine, "status": st["status"],
                                        "caps": st["caps"]}}


@hub_router.delete("/machines/{mid}")
async def delete_machine(mid: str):
    remove_machine(mid)
    return {"status": "ok", "removed": mid}


# ── Control proxy (dashboard on/off, GPU pin) — přeposka na stroj/agenta ──

CONTROL_TIMEOUT = float(os.environ.get("HUB_CONTROL_TIMEOUT", "120"))


async def _control_post(mid: str, paths: str | list[str], payload: dict | None = None) -> dict:
    """POST na stroj {mid}{path} — zkusí cesty postupně (api-wrapper vs server.py);
    404 → další cesta; jiná chyba fail-loud (502/503)."""
    if isinstance(paths, str):
        paths = [paths]
    try:
        base = machine_base_url(mid)
    except KeyError:
        raise HTTPException(400, f"unknown machine {mid}")
    st = _machine_status(mid)
    if not st["caps"]:
        raise HTTPException(503, f"machine {mid} is down")
    last_detail = "no path worked"
    try:
        async with httpx.AsyncClient(timeout=CONTROL_TIMEOUT) as client:
            for path in paths:
                r = await client.post(f"{base.rstrip('/')}{path}", json=payload or {})
                if r.status_code == 404:
                    last_detail = f"{path}: 404"
                    continue  # starší backend bez této cesty → zkus další variantu
                if r.status_code >= 400:
                    detail = r.text[:300] if r.text else f"HTTP {r.status_code}"
                    raise HTTPException(502, f"{path} on {mid} failed: {detail}")
                return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"status": "ok"}
    except httpx.HTTPError as e:
        raise HTTPException(502, f"control call failed: {e}")
    raise HTTPException(502, f"control {paths} on {mid} failed: {last_detail}")


async def _agent_post(mid: str, path: str, timeout: float | None = None) -> dict:
    """POST na hub-agenta stroje {mid}{path} — vyžaduje agent_url v machines.yaml."""
    try:
        base = machine_agent_url(mid)
    except KeyError:
        raise HTTPException(400, f"unknown machine {mid}")
    if not base:
        raise HTTPException(501, f"machine {mid} nemá agent_url (hub-agent nenakonfigurován)")
    try:
        async with httpx.AsyncClient(timeout=timeout or CONTROL_TIMEOUT) as client:
            r = await client.post(f"{base}{path}")
        if r.status_code >= 400:
            detail = r.text[:300] if r.text else f"HTTP {r.status_code}"
            raise HTTPException(502, f"agent {path} on {mid} failed: {detail}")
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else {"status": "ok"}
    except httpx.HTTPError as e:
        raise HTTPException(502, f"agent call failed: {e}")


async def _reprobe(mid: str) -> None:
    m = next((m for m in load_machines() if m["id"] == mid), None)
    if m:
        await _probe_once(m)


@hub_router.post("/machines/{mid}/services/{sid}/start")
async def service_start(mid: str, sid: str):
    res = await _agent_post(mid, f"/services/{sid}/start")
    await _reprobe(mid)
    return {"status": "ok", "machine": mid, "service": sid, "result": res}


@hub_router.post("/machines/{mid}/services/{sid}/stop")
async def service_stop(mid: str, sid: str):
    res = await _agent_post(mid, f"/services/{sid}/stop")
    await _reprobe(mid)
    return {"status": "ok", "machine": mid, "service": sid, "result": res}


@hub_router.post("/machines/{mid}/gpu-select")
async def machine_gpu_select(mid: str, payload: dict):
    device = payload.get("device", "auto")
    # api-wrapper stroj: /api/gpu-select; server.py stroj: /gpu-select
    res = await _control_post(mid, ["/api/gpu-select", "/gpu-select"], {"device": device})
    return {"status": "ok", "machine": mid, "device": device, "result": res}


@hub_router.post("/machines/{mid}/unload")
async def machine_unload(mid: str):
    # api-wrapper stroj: /api/unload; server.py stroj: /unload
    res = await _control_post(mid, ["/api/unload", "/unload"])
    return {"status": "ok", "machine": mid, "result": res}


@hub_router.get("/machines/{mid}/logs")
async def machine_logs(mid: str, service: str = "", tail: int = 100):
    try:
        base = machine_agent_url(mid)
    except KeyError:
        raise HTTPException(400, f"unknown machine {mid}")
    if not base:
        raise HTTPException(501, f"machine {mid} nemá agent_url (hub-agent nenakonfigurován)")
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.get(f"{base.rstrip('/')}/logs",
                                 params={"service": service, "tail": tail})
    except httpx.HTTPError as e:
        raise HTTPException(502, f"logs call failed: {e}")
    if r.status_code >= 400:
        raise HTTPException(502, f"logs on {mid} failed: HTTP {r.status_code}")
    return {"machine": mid, "service": service, "logs": r.text[-4000:]}


# ── Desired state API (dashboard) ─────────────────────────

@hub_router.get("/desired")
async def get_desired():
    return {"desired": _desired, "drift": drift()}


@hub_router.post("/desired")
async def set_desired_route(payload: dict):
    sid = str(payload.get("service", "")).strip()
    if not sid:
        raise HTTPException(400, "service is required")
    machine = str(payload.get("machine") or "").strip() or None
    if machine and machine not in _machine_ids():
        raise HTTPException(400, f"unknown machine {machine}")
    gpu = payload.get("gpu")
    if gpu is not None and not isinstance(gpu, (int, str)):
        raise HTTPException(400, "gpu musí být index (int) nebo 'auto'")
    enabled = bool(payload.get("enabled", False))
    saved = set_desired(sid, machine, gpu, enabled)
    return {"status": "ok", "service": sid, "desired": saved, "drift": drift()}


@hub_router.delete("/desired/{sid}")
async def delete_desired(sid: str):
    _desired.pop(sid, None)
    save_desired()
    return {"status": "ok", "removed": sid}


# ── Cluster mode (auto | manual) + režimy strojů + auto-návrat ──

CLUSTER_FILE = Path(os.environ.get("HUB_CLUSTER_FILE", "/data/hub_cluster.yaml"))
MODE_WAIT_TIMEOUT = float(os.environ.get("HUB_MODE_TIMEOUT", "300"))
MODE_POLL_INTERVAL = float(os.environ.get("HUB_MODE_POLL_INTERVAL", "3"))
AUTO_RETURN_CHECK_S = float(os.environ.get("HUB_AUTO_RETURN_CHECK_S", "30"))

_cluster: dict = {"cluster_mode": "auto", "machines": {}}
_auto_return_task: asyncio.Task | None = None
# machine_id → timestamp poslední aktivity (proxy generace, přepnutí režimu)
_last_activity: dict[str, float] = {}


def _load_cluster() -> None:
    global _cluster
    if not CLUSTER_FILE.is_file():
        return
    try:
        cfg = yaml.safe_load(CLUSTER_FILE.read_text()) or {}
    except yaml.YAMLError as e:
        log.warning("cluster file %s unparseable: %s", CLUSTER_FILE, e)
        return
    _cluster = {
        "cluster_mode": cfg.get("cluster_mode", "auto"),
        "machines": cfg.get("machines") or {},
    }
    if _cluster["cluster_mode"] not in ("auto", "manual"):
        _cluster["cluster_mode"] = "auto"


def save_cluster() -> None:
    CLUSTER_FILE.parent.mkdir(parents=True, exist_ok=True)
    CLUSTER_FILE.write_text(yaml.safe_dump(_cluster, sort_keys=False, allow_unicode=True))


def cluster_mode() -> str:
    return _cluster["cluster_mode"]


def require_auto_mode() -> None:
    """Gate pro všechny automatické cesty (proxy, auto-návrat). Fail-loud v MANUAL."""
    if _cluster["cluster_mode"] != "auto":
        raise HTTPException(503, "cluster je v MANUAL režimu — automatické generování je blokováno")


def _machine_config(mid: str) -> dict:
    return (_cluster.get("machines") or {}).get(mid) or {}


def _service_mode(caps: dict, sid: str) -> str | None:
    svc = next((s for s in (caps.get("services") or []) if s.get("id") == sid), None)
    return (svc or {}).get("mode")


def machine_active_modes(mid: str) -> list[str]:
    """Režimy, které mají na stroji aktuálně nějakou běžící službu."""
    caps = (_machine_status(mid).get("caps") or {})
    modes = set()
    for s in (caps.get("services") or []):
        if s.get("running") and s.get("mode"):
            modes.add(s["mode"])
    return sorted(modes)


def machine_current_mode(mid: str) -> str | None:
    """Aktivní režim stroje: jediný běžící režim; více najednou → None (nekonzistentní stav)."""
    modes = machine_active_modes(mid)
    return modes[0] if len(modes) == 1 else None


@hub_router.get("/cluster-mode")
async def get_cluster_mode():
    return {"cluster_mode": _cluster["cluster_mode"], "machines": _cluster["machines"],
            "active_modes": {m["id"]: machine_active_modes(m["id"]) for m in load_machines()}}


@hub_router.put("/cluster-mode")
async def put_cluster_mode(payload: dict):
    global _cluster
    mode = str(payload.get("mode", "")).strip().lower()
    if mode not in ("auto", "manual"):
        raise HTTPException(400, "mode musí být 'auto' nebo 'manual'")
    old = _cluster["cluster_mode"]
    _cluster["cluster_mode"] = mode
    save_cluster()
    log.info("CLUSTER MODE CHANGE: %s → %s", old, mode)
    return {"status": "ok", "cluster_mode": mode, "previous": old}


def default_mode(mid: str) -> str | None:
    mc = _machine_config(mid)
    return mc.get("default_mode")


@hub_router.post("/machines/{mid}/mode/{mode}")
async def switch_machine_mode(mid: str, mode: str):
    """Přepnutí režimu stroje: stop služeb ostatních režimů → start cílových → health wait.

    Ruční akce operátora — funguje v obou režimech klastru. Fail-loud report.
    """
    if mid not in _machine_ids():
        raise HTTPException(400, f"unknown machine {mid}")
    st = _machine_status(mid)
    caps = st.get("caps")
    if not caps:
        raise HTTPException(503, f"machine {mid} is down")

    services = caps.get("services") or []
    target_sids = [s["id"] for s in services if s.get("mode") == mode]
    other_running = [s for s in services if s.get("running") and s.get("mode") and s["mode"] != mode]
    if not target_sids and not any(s.get("mode") == mode for s in services):
        raise HTTPException(400, f"režim '{mode}' nemá na stroji {mid} žádné služby")

    stopped, started, failed = [], [], []

    # 1) stop služeb ostatních režimů (nejdřív uvolnit VRAM)
    for s in other_running:
        try:
            await _agent_post(mid, f"/services/{s['id']}/stop")
            stopped.append(s["id"])
        except HTTPException as e:
            failed.append({"service": s["id"], "action": "stop", "error": str(e.detail)})

    # 2) start služeb cílového režimu, které neběží
    running_ids = {s["id"] for s in services if s.get("running")}
    for sid in target_sids:
        if sid in running_ids:
            continue
        try:
            await _agent_post(mid, f"/services/{sid}/start")
            started.append(sid)
        except HTTPException as e:
            failed.append({"service": sid, "action": "start", "error": str(e.detail)})

    # 3) poll dokud cílové služby nedoběhnou healthcheck (modely se natahují dlouho)
    deadline = time.time() + MODE_WAIT_TIMEOUT
    while time.time() < deadline:
        await asyncio.sleep(MODE_POLL_INTERVAL)
        await _probe_once(next(m for m in load_machines() if m["id"] == mid))
        caps_now = (_machine_status(mid).get("caps") or {})
        by_id = {s["id"]: s for s in (caps_now.get("services") or [])}
        if all(by_id.get(sid, {}).get("running") for sid in target_sids if sid not in [f["service"] for f in failed]):
            break

    # 4) fail-loud: jakákoli porucha = non-ok odpověď s detaily
    status = "ok" if not failed else "partial"
    _last_activity[mid] = time.time()
    result = {"status": status, "machine": mid, "mode": mode,
              "stopped": stopped, "started": started, "failed": failed,
              "timeout_reached": time.time() >= deadline}
    if failed:
        raise HTTPException(502, f"přepnutí režimu {mode} na {mid} částečně selhalo: {result}")
    return result


async def ensure_service_running(mid: str, sid: str, timeout_s: float | None = None) -> dict:
    """Zajistí, že služba běží: pokud ne, startuje ji a čeká na running. Reuse proxy i režimy."""
    st = _machine_status(mid)
    caps = st.get("caps")
    if not caps:
        raise HTTPException(503, f"machine {mid} is down")
    svc = next((s for s in (caps.get("services") or []) if s.get("id") == sid), None)
    if svc is None:
        raise HTTPException(400, f"stroj {mid} nezná službu {sid}")
    if svc.get("running"):
        return {"status": "already-running", "machine": mid, "service": sid}

    await _agent_post(mid, f"/services/{sid}/start")
    timeout = timeout_s or MODE_WAIT_TIMEOUT
    deadline = time.time() + timeout
    while time.time() < deadline:
        await asyncio.sleep(MODE_POLL_INTERVAL)
        await _reprobe(mid)
        caps_now = (_machine_status(mid).get("caps") or {})
        now_svc = next((s for s in (caps_now.get("services") or []) if s.get("id") == sid), None)
        if now_svc and now_svc.get("running"):
            return {"status": "started", "machine": mid, "service": sid}
    raise HTTPException(504, f"služba {sid} na {mid} se nenastartovala do {int(timeout)} s")


@hub_router.post("/machines/{mid}/services/{sid}/ensure-running")
async def ensure_running_route(mid: str, sid: str):
    require_auto_mode()
    res = await ensure_service_running(mid, sid)
    _last_activity[mid] = time.time()
    return res


# ── Auto-návrat na výchozí režim po nečinnosti (jen AUTO cluster mode) ──

def note_activity(mid: str) -> None:
    """Zapiš aktivitu stroje (volá proxy při každé generaci)."""
    _last_activity[mid] = time.time()


async def _auto_return_loop() -> None:
    while True:
        try:
            if _cluster["cluster_mode"] == "auto":
                for m in load_machines():
                    mid = m["id"]
                    mc = _machine_config(mid)
                    minutes = int(mc.get("auto_return_minutes") or 0)
                    if minutes <= 0:
                        continue
                    dm = mc.get("default_mode")
                    if not dm or machine_current_mode(mid) == dm:
                        continue
                    last = _last_activity.get(mid)
                    if last is None:
                        continue  # bez známé aktivity nic nepřepínej
                    idle_min = (time.time() - last) / 60
                    if idle_min >= minutes:
                        log.info("AUTO-RETURN: %s nečinný %.0f min → návrat na režim '%s'",
                                 mid, idle_min, dm)
                        try:
                            await switch_machine_mode(mid, dm)
                        except Exception as e:
                            log.warning("auto-return %s selhal: %s", mid, e)
        except Exception as e:
            log.warning("auto-return loop error: %s", e)
        await asyncio.sleep(AUTO_RETURN_CHECK_S)


def start_auto_return() -> None:
    global _auto_return_task
    if _auto_return_task is None or _auto_return_task.done():
        _auto_return_task = asyncio.create_task(_auto_return_loop())


async def stop_auto_return() -> None:
    global _auto_return_task
    if _auto_return_task:
        _auto_return_task.cancel()
        try:
            await _auto_return_task
        except asyncio.CancelledError:
            pass
        _auto_return_task = None


@hub_router.put("/machines/{mid}/config")
async def set_machine_config(mid: str, payload: dict):
    """Konfigurace stroje: default_mode, auto_return_minutes."""
    if mid not in _machine_ids():
        raise HTTPException(400, f"unknown machine {mid}")
    mc = _cluster["machines"].setdefault(mid, {})
    for key in ("default_mode", "auto_return_minutes"):
        if key in payload:
            mc[key] = payload[key]
    save_cluster()
    return {"status": "ok", "machine": mid, "config": mc}


# ── Hub-agent proxy: toggles + queue ─────────────────────
# Per-stroj ovládání (toggles) a fronta GHE jobů běží v hub-agent (port 8199).
# api-wrapper proxyuje tyto endpointy, aby je webapp mohl volat jednotně přes /api/hub/*.

async def _proxy_agent(mid: str, path: str, method: str, body: dict | None) -> dict:
    """Proxy GET/POST na hub-agent stroje. path např. 'queue', 'queue/{id}/cancel'."""
    try:
        base = machine_agent_url(mid)
    except KeyError:
        raise HTTPException(404, f"unknown machine {mid}")
    if not base:
        raise HTTPException(400, f"machine {mid} nemá agent_url — toggle/queue jen pro stroje s hub-agentem")
    url = f"{base.rstrip('/')}/{path.lstrip('/')}"
    timeout = 600.0 if "queue" in path and method == "POST" else 30.0
    async with httpx.AsyncClient(timeout=timeout) as client:
        if method == "GET":
            r = await client.get(url)
        elif method == "POST":
            r = await client.post(url, json=body or {})
        else:
            raise HTTPException(405, f"method {method} not supported")
    if r.status_code >= 400:
        try:
            detail = r.json().get("detail", r.text)
        except Exception:
            detail = r.text
        raise HTTPException(r.status_code, detail)
    if not r.content:
        return {"status": "ok"}
    try:
        return r.json()
    except Exception:
        return {"status": "ok", "raw": r.text}


@hub_router.get("/machines/{mid}/toggles")
async def get_toggles(mid: str):
    return await _proxy_agent(mid, "toggles", "GET", None)


@hub_router.post("/machines/{mid}/toggles")
async def set_toggles(mid: str, payload: dict):
    return await _proxy_agent(mid, "toggles", "POST", payload)


@hub_router.post("/machines/{mid}/toggles/bulk")
async def set_toggles_bulk(mid: str, payload: dict):
    return await _proxy_agent(mid, "toggles/bulk", "POST", payload)


@hub_router.get("/machines/{mid}/queue")
async def list_queue(mid: str):
    return await _proxy_agent(mid, "api/queue", "GET", None)


@hub_router.post("/machines/{mid}/queue")
async def push_queue(mid: str, payload: dict):
    return await _proxy_agent(mid, "api/queue", "POST", payload)


@hub_router.get("/machines/{mid}/queue/{jid}/status")
async def queue_status(mid: str, jid: str):
    return await _proxy_agent(mid, f"api/queue/{jid}/status", "GET", None)


@hub_router.post("/machines/{mid}/queue/{jid}/ready")
async def queue_ready(mid: str, jid: str, payload: dict | None = None):
    return await _proxy_agent(mid, f"api/queue/{jid}/ready", "POST", payload)


@hub_router.post("/machines/{mid}/queue/{jid}/running")
async def queue_running(mid: str, jid: str):
    return await _proxy_agent(mid, f"api/queue/{jid}/running", "POST", None)


@hub_router.post("/machines/{mid}/queue/{jid}/done")
async def queue_done(mid: str, jid: str, payload: dict | None = None):
    return await _proxy_agent(mid, f"api/queue/{jid}/done", "POST", payload)


@hub_router.post("/machines/{mid}/queue/{jid}/cancel")
async def queue_cancel(mid: str, jid: str):
    return await _proxy_agent(mid, f"api/queue/{jid}/cancel", "POST", None)


@hub_router.get("/machines/{mid}/gpu-locks")
async def gpu_locks(mid: str):
    return await _proxy_agent(mid, "gpu-locks", "GET", None)
