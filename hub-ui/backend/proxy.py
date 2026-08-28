"""Proxy router — automatizované generování podle typu úlohy (FÁZE 3).

Automatizace (content-factory, GHE workflows, skripty) volají JEDEN endpoint:
    POST /api/proxy/{kind}/generate     kind ∈ tts | image | video | stt | llm

Chování (jen v cluster AUTO režimu; MANUAL → 503 fail-loud):
1. require_auto_mode() — gate
2. _resolve_target(kind): desired[service] → assignment[kind] → 503 „nenastaveno“
3. kontrola režimu stroje — nesprávný režim → 503 s důvodem (žádné tiché přepínání;
   přepnutí režimu zůstává ruční akce operátora / auto-návrat)
4. auto-start: služba neběží → hub-agent start + health poll
5. forward na {machine}/api/generate (fallback legacy /generate), passthrough bytes
6. hlavička X-Served-By: {machine} + zápis aktivity pro auto-návrat

Žádný load balancing, žádný retry napříč stroji mimo deklarovaný fallback chain.
"""
import logging
import time

import httpx
from fastapi import APIRouter, HTTPException, Response

import hub

log = logging.getLogger("comfyui-webapp.proxy")

proxy_router = APIRouter(prefix="/api/proxy", tags=["proxy"])

PROXY_KINDS = ("tts", "image", "video", "stt", "llm")
# service_kind → id služby v capabilities (capabilities používají type pole)
_KIND_SERVICE_TYPE = {k: k for k in PROXY_KINDS}

GENERATE_TIMEOUT = float(__import__("os").environ.get("PROXY_GENERATE_TIMEOUT", "600"))
START_TIMEOUT = float(__import__("os").environ.get("PROXY_START_TIMEOUT", "300"))

_proxy_status: dict[str, dict] = {}  # kind → {machine, service, last_used_ts}


def _services_of_type(mid: str, kind: str) -> list[dict]:
    """Služby stroje mid daného typu (z posledního probe)."""
    caps = (hub._machine_status(mid).get("caps") or {})
    return [s for s in (caps.get("services") or []) if s.get("type") == kind]


def _resolve_target(kind: str) -> dict:
    """desired[service] → assignment[kind] → 503. Vrací {machine, service}."""
    # 1) desired state: uživatel nastavil službu daného typu na konkrétní stroj
    for sid, want in hub._desired.items():
        if not want.get("enabled"):
            continue
        st = hub._machine_status(want["machine"])
        svc = next((s for s in ((st.get("caps") or {}).get("services") or [])
                    if s.get("id") == sid and s.get("type") == kind), None)
        if svc:
            machine = want["machine"]
            reason = f"desired[{sid}]"
            break
    else:
        # 2) assignment per service_kind (primary up → primary; jinak fallback)
        res = hub.resolve(kind)
        machine = res.get("machine")
        reason = res.get("reason", "assignment")
        if not machine:
            raise HTTPException(503,
                                f"proxy/{kind}: není nastaveno desired ani assignment "
                                f"(primary={res.get('primary')}, fallback={res.get('fallback')})")
        svc = next((_services_of_type(machine, kind)[0] for _ in [0]
                    if _services_of_type(machine, kind)), None)
        if svc is None:
            raise HTTPException(503,
                                f"proxy/{kind}: stroj {machine} nehlásí žádnou službu typu '{kind}'")
        sid = svc["id"]

    st = hub._machine_status(machine)
    if not st.get("caps"):
        raise HTTPException(503, f"proxy/{kind}: cílový stroj {machine} je down")
    return {"machine": machine, "service": sid, "reason": reason,
            "mode": svc.get("mode")}


@proxy_router.post("/{kind}/generate")
async def proxy_generate(kind: str, payload: dict):
    if kind not in PROXY_KINDS:
        raise HTTPException(404, f"unknown kind '{kind}' (znám: {', '.join(PROXY_KINDS)})")

    hub.require_auto_mode()

    target = _resolve_target(kind)
    mid, sid = target["machine"], target["service"]

    # kontrola režimu stroje — nesprávný režim = fail-loud (žádné tiché přepínání)
    active = hub.machine_active_modes(mid)
    if target.get("mode") and active and target["mode"] not in active:
        raise HTTPException(
            503, f"proxy/{kind}: stroj {mid} je v režimu {'/'.join(active)}, "
                 f"ale služba {sid} patří do režimu '{target['mode']}'. "
                 f"Přepni režim ručně (Dashboard) nebo nastav auto-návrat.")

    # auto-start služby před runem
    await hub.ensure_service_running(mid, sid, timeout_s=START_TIMEOUT)

    # forward — api-wrapper stroje: /api/generate; legacy server.py: /generate
    base = hub.machine_base_url(mid).rstrip("/")
    async with httpx.AsyncClient(timeout=GENERATE_TIMEOUT) as client:
        r = None
        for path in ("/api/generate", "/generate"):
            try:
                r = await client.post(f"{base}{path}", json=payload)
            except httpx.ConnectError as e:
                raise HTTPException(502, f"proxy/{kind}: {mid} unreachable: {e}")
            if r.status_code == 404:
                continue
            break
        if r is None or r.status_code == 404:
            raise HTTPException(502, f"proxy/{kind}: {mid} nemá generate endpoint")
        if r.status_code != 200:
            detail = r.text[:500] if r.text else f"HTTP {r.status_code}"
            raise HTTPException(502, f"proxy/{kind}: generate on {mid} failed: {detail}")

    hub.note_activity(mid)
    _proxy_status[kind] = {"machine": mid, "service": sid, "last_used_ts": time.time(),
                           "last_reason": target["reason"]}

    media = r.headers.get("content-type", "application/octet-stream")
    return Response(content=r.content, media_type=media,
                    headers={"X-Served-By": mid, "X-Service": sid})


@proxy_router.get("/status")
async def proxy_status():
    out = {}
    for kind in PROXY_KINDS:
        entry = {"last_used": _proxy_status.get(kind)}
        try:
            t = _resolve_target(kind)
            entry["resolved"] = {"machine": t["machine"], "service": t["service"],
                                 "reason": t["reason"], "mode": t.get("mode")}
            running = [s.get("running") for s in _services_of_type(t["machine"], kind)]
            entry["running"] = any(running)
            entry["cluster_mode"] = hub.cluster_mode()
        except HTTPException as e:
            entry["error"] = str(e.detail)
        out[kind] = entry
    return {"kinds": out}
