"""
comfyui-webapp — FastAPI proxy + SQLite + statika.

Stojí před comfyui-unified (:8188) a přidává to, co backend neumí:
GPU monitoring, historii generování, presetové knihovny a webové UI.

Backend comfyui-unified zůstává nedotčený. Tento wrapper je samostatný
kontejner s minimálními závislostmi (žádný torch, žádný CUDA build).
"""

import asyncio
import json
import logging
import os
import re
import socket
import sqlite3
import subprocess
import threading
import time
import uuid
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import hub as hub_module
from hub import hub_router
from proxy import proxy_router
from stt import stt_router
from video import video_router
from llm import llm_router
from webui_registry import webui_router

log = logging.getLogger("comfyui-webapp")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

app = FastAPI(title="ComfyUI Unified Webapp", version="1.0.0")
# Routers (order matters — specific paths first)
app.include_router(hub_router)
app.include_router(proxy_router)
app.include_router(stt_router)
app.include_router(video_router)
app.include_router(llm_router)
app.include_router(webui_router)

# Per-machine: container name je comfyui-${MACHINE_ID} v master docker-compose
COMFYUI_HOST = os.environ.get("COMFYUI_HOST", "comfyui-aiworker")
BACKEND_URL = os.environ.get("COMFYUI_UNIFIED_URL", f"http://{COMFYUI_HOST}:8188").rstrip("/")
DB_PATH = Path(os.environ.get("WEBAPP_DB", "/data/webapp.db"))
WEBAPP_DIR = Path(os.environ.get("WEBAPP_DIR", "webapp"))
OUTPUT_DIR = Path(os.environ.get("WEBAPP_OUTPUT_DIR", "/data/outputs"))

HEALTH_TIMEOUT = float(os.environ.get("WEBAPP_HEALTH_TIMEOUT", "10"))
GENERATE_TIMEOUT = float(os.environ.get("WEBAPP_GENERATE_TIMEOUT", "1900"))
BENCHMARK_TIMEOUT = float(os.environ.get("WEBAPP_BENCHMARK_TIMEOUT", "3700"))
PROXY_TIMEOUT = float(os.environ.get("WEBAPP_PROXY_TIMEOUT", "60"))
MODEL_REFRESH_SECONDS = float(os.environ.get("WEBAPP_MODEL_REFRESH", "60"))

# ── SQLite ────────────────────────────────────────────────

_db_lock = threading.Lock()
_db: sqlite3.Connection | None = None


def _get_db() -> sqlite3.Connection:
    global _db
    if _db is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _db = sqlite3.connect(str(DB_PATH), check_same_thread=False)
        _db.row_factory = sqlite3.Row
        _db.executescript(
            """
            CREATE TABLE IF NOT EXISTS history (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              kind TEXT NOT NULL,
              model TEXT NOT NULL,
              prompt TEXT,
              negative_prompt TEXT,
              params TEXT,
              status TEXT NOT NULL,
              error TEXT,
              duration_ms INTEGER,
              bytes INTEGER,
              device TEXT,
              mimetype TEXT,
              output_path TEXT
            );
            CREATE TABLE IF NOT EXISTS templates (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              kind TEXT NOT NULL,
              content TEXT NOT NULL,
              category TEXT,
              language TEXT,
              model_hint TEXT,
              is_seed INTEGER DEFAULT 0,
              created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
              updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            """
        )
        _db.commit()
        _migrate(_db)
    return _db


def _migrate(db: sqlite3.Connection):
    cols = {r[1] for r in db.execute("PRAGMA table_info(history)")}
    if "device" not in cols:
        db.execute("ALTER TABLE history ADD COLUMN device TEXT")
        log.info("migrated: history.device")
    if "mimetype" not in cols:
        db.execute("ALTER TABLE history ADD COLUMN mimetype TEXT")
        log.info("migrated: history.mimetype")
    if "output_path" not in cols:
        db.execute("ALTER TABLE history ADD COLUMN output_path TEXT")
        log.info("migrated: history.output_path")
    if "machine" not in cols:
        db.execute("ALTER TABLE history ADD COLUMN machine TEXT")
        log.info("migrated: history.machine")
    db.commit()


# ── Model kind cache ──────────────────────────────────────

_model_kind: dict[str, str] = {}
_model_meta: dict[str, dict] = {}
_model_loaded_at: float = 0.0


async def refresh_models() -> None:
    global _model_kind, _model_meta, _model_loaded_at
    try:
        async with httpx.AsyncClient(timeout=HEALTH_TIMEOUT) as client:
            r = await client.get(f"{BACKEND_URL}/models")
        if r.status_code == 200:
            data = r.json()
            models = data.get("models", [])
            _model_kind = {m["id"]: m.get("kind", "") for m in models}
            _model_meta = {m["id"]: m for m in models}
            _model_loaded_at = time.time()
            log.info("Model cache refreshed: %d models", len(models))
        else:
            log.warning("Model refresh HTTP %d", r.status_code)
    except Exception as e:
        log.warning("Model refresh failed: %s", e)


def _kind_for(model: str) -> str:
    return _model_kind.get(model, "")


async def _maybe_refresh_models() -> None:
    if time.time() - _model_loaded_at > MODEL_REFRESH_SECONDS:
        await refresh_models()


# ── Helpers ───────────────────────────────────────────────

async def _forward(method: str, path: str, payload: dict | None = None,
                   timeout: float = PROXY_TIMEOUT, return_meta: bool = False):
    url = f"{BACKEND_URL}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            if method == "GET":
                r = await client.get(url)
            elif method == "POST":
                r = await client.post(url, json=payload)
            else:
                raise HTTPException(400, f"Unsupported method: {method}")
    except httpx.ConnectError:
        raise HTTPException(503, f"Backend comfyui-unified unreachable at {BACKEND_URL}")
    except httpx.TimeoutException:
        raise HTTPException(504, f"Backend timed out after {timeout}s")

    if return_meta:
        return r
    try:
        content = r.json() if r.content else {}
    except ValueError:
        # backend vrátil ne-JSON odpověď (např. text/HTML error) — přepošli jako detail
        content = {"detail": r.text[:300] if r.text else f"HTTP {r.status_code}"}
    return JSONResponse(content=content, status_code=r.status_code)


async def _forward_binary(method: str, path: str, timeout: float = PROXY_TIMEOUT):
    url = f"{BACKEND_URL}{path}"
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            if method == "GET":
                r = await client.get(url)
            else:
                raise HTTPException(400, f"Unsupported method: {method}")
    except httpx.ConnectError:
        raise HTTPException(503, f"Backend comfyui-unified unreachable at {BACKEND_URL}")
    except httpx.TimeoutException:
        raise HTTPException(504, f"Backend timed out after {timeout}s")
    return Response(content=r.content, media_type=r.headers.get("content-type", "application/octet-stream"), status_code=r.status_code)


_gpu_stats_cache: tuple[float, list[dict]] = (0.0, [])


def _gpu_stats() -> list[dict]:
    global _gpu_stats_cache
    # krátká cache — webapp polluje po 1 s, nvidia-smi je drahý
    ts, cached = _gpu_stats_cache
    if cached and time.time() - ts < 1.5:
        return cached
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "-x", "-q"],
            timeout=5,
            stderr=subprocess.PIPE,
        ).decode("utf-8", errors="replace")
    except Exception as e:
        log.warning("nvidia-smi failed: %s", e)
        return []

    gpus = []
    try:
        import xml.etree.ElementTree as ET
        root = ET.fromstring(out)
        for g in root.findall("gpu"):
            gpu = {"power_w": 0.0, "temperature_c": 0, "gpu_util_pct": 0, "memory_util_pct": 0}
            pn = g.find("product_name")
            gpu["name"] = pn.text if pn is not None else "unknown"

            fb = g.find("fb_memory_usage")
            if fb is not None:
                total = fb.find("total")
                used = fb.find("used")
                free = fb.find("free")
                gpu["memory_total_mb"] = int(float(total.text.split()[0])) if total is not None and total.text else 0
                gpu["memory_used_mb"] = int(float(used.text.split()[0])) if used is not None and used.text else 0
                gpu["memory_free_mb"] = int(float(free.text.split()[0])) if free is not None and free.text else 0

            util = g.find("utilization")
            if util is not None:
                gu = util.find("gpu_util")
                mu = util.find("memory_util")
                gpu["gpu_util_pct"] = int(float(gu.text.split()[0])) if gu is not None and gu.text else 0
                gpu["memory_util_pct"] = int(float(mu.text.split()[0])) if mu is not None and mu.text else 0

            temp = g.find("temperature")
            if temp is not None:
                gt = temp.find("gpu_temp")
                gpu["temperature_c"] = int(float(gt.text.split()[0])) if gt is not None and gt.text else 0

            power = g.find("gpu_power_readings")
            if power is not None:
                pd = power.find("power_draw")
                if pd is None:
                    pd = power.find("instant_power_draw")
                gpu["power_w"] = float(pd.text.split()[0]) if pd is not None and pd.text else 0.0

            gpus.append(gpu)
    except Exception:
        log.exception("GPU XML parse failed")

    _gpu_stats_cache = (time.time(), gpus)
    return gpus


def _sniff_media_type(content: bytes, fallback: str) -> str:
    """Backend někdy vrací FLAC s MIME audio/wav — oprav podle magických bytů."""
    if content.startswith(b"fLaC"):
        return "audio/flac"
    if content.startswith(b"RIFF"):
        return "audio/wav"
    if content.startswith(b"OggS"):
        return "audio/ogg"
    if content.startswith(b"ID3") or (len(content) > 2 and content[0] == 0xFF and (content[1] & 0xE0) == 0xE0):
        return "audio/mpeg"
    if content.startswith(b"\x89PNG"):
        return "image/png"
    if content.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    return fallback


def _record_history(kind: str, model: str, prompt: str, negative_prompt: str,
                    params: dict, status: str, error: str | None,
                    duration_ms: int, nbytes: int, device: str = "",
                    mimetype: str = "", output_path: str = "", machine: str = "") -> int:
    with _db_lock:
        cur = _get_db().execute(
            "INSERT INTO history (kind, model, prompt, negative_prompt, params, status, error, duration_ms, bytes, device, mimetype, output_path, machine) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (kind, model, prompt, negative_prompt, json.dumps(params, ensure_ascii=False),
             status, error, duration_ms, nbytes, device, mimetype, output_path, machine),
        )
        _get_db().commit()
        return cur.lastrowid


# ── Proxy endpoints ───────────────────────────────────────

@app.get("/api/health")
async def health():
    await _maybe_refresh_models()
    r = await _forward("GET", "/health", return_meta=True)
    body = r.json() if r.content else {}
    body["models_cache"] = {
        "count": len(_model_kind),
        "age_s": round(time.time() - _model_loaded_at, 1) if _model_loaded_at else None,
    }
    return JSONResponse(content=body, status_code=r.status_code)


@app.get("/api/models")
async def list_models():
    await _maybe_refresh_models()
    return {"gpu": None, "models": list(_model_meta.values())}


@app.get("/api/voices")
async def voices():
    return await _forward("GET", "/voices")


@app.post("/api/design-voice")
async def design_voice(req: dict):
    return await _forward("POST", "/design-voice", req, timeout=GENERATE_TIMEOUT)


@app.post("/api/save-voice")
async def save_voice(req: dict):
    return await _forward("POST", "/save-voice", req, timeout=PROXY_TIMEOUT)


@app.get("/api/voice/{voice_id}/audio")
async def voice_audio(voice_id: str):
    return await _forward_binary("GET", f"/voice/{voice_id}/audio")


@app.post("/api/benchmark")
async def benchmark(req: dict):
    r = await _forward("POST", "/benchmark", req, timeout=BENCHMARK_TIMEOUT, return_meta=True)
    try:
        body = r.json() if r.content else {}
    except ValueError:
        body = {"detail": r.text[:500] if r.text else f"HTTP {r.status_code}"}
    if r.status_code >= 400:
        return JSONResponse(content=body, status_code=r.status_code)

    # The benchmark endpoint bypasses /api/generate, so it must persist its
    # individual runs here instead of silently disappearing from History.
    model = str(req.get("model", ""))
    prompt = str(req.get("prompt", ""))
    negative_prompt = str(req.get("negative_prompt", ""))
    for result in body.get("results", []):
        run_params = dict(req)
        run_params["benchmark_run"] = result.get("run")
        duration_ms = round(float(result.get("gen_time_s", 0)) * 1000) if result.get("success") else 0
        _record_history(
            "image", model, prompt, negative_prompt, run_params,
            "ok" if result.get("success") else "error",
            result.get("error") if not result.get("success") else None,
            duration_ms, 0,
        )
    return JSONResponse(content=body, status_code=r.status_code)


@app.post("/api/free")
async def free_vram():
    return await _forward("POST", "/free")


@app.post("/api/unload")
async def unload_vram():
    return await _forward("POST", "/unload", timeout=PROXY_TIMEOUT + 30)


@app.get("/api/logs")
async def logs(tail: int = Query(100, ge=1, le=2000)):
    r = await _forward("GET", f"/logs?tail={tail}", return_meta=True)
    return JSONResponse(content=r.json() if r.content else {}, status_code=r.status_code)


@app.get("/api/gpus")
async def gpus():
    return await _forward("GET", "/gpus")


@app.get("/api/generation-status")
async def generation_status():
    return await _forward("GET", "/generation-status")


@app.get("/api/timing-history")
async def timing_history():
    return await _forward("GET", "/api/timing-history")


@app.post("/api/gpu-select")
async def gpu_select(req: dict):
    return await _forward("POST", "/gpu-select", req, timeout=PROXY_TIMEOUT + 300)


@app.post("/api/cancel")
async def cancel_generation():
    return await _forward("POST", "/cancel")


@app.get("/api/events")
async def events():
    """SSE relay z backendu (logy + progress)."""
    async def stream():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("GET", f"{BACKEND_URL}/events") as r:
                    async for chunk in r.aiter_text():
                        yield chunk
        except Exception:
            pass  # EventSource na klientu se sám připojí znovu

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Generate (binary passthrough + history) ───────────────

@app.post("/api/generate")
async def generate(req: dict):
    model = str(req.get("model", ""))
    if not model:
        raise HTTPException(400, "model is required")

    # FÁZE 2: volitelný cílový stroj (uživatelův výběr v Hub UI) — žádný auto-routing
    machine = str(req.pop("machine", "") or "").strip()
    if machine:
        try:
            base = hub_module.machine_base_url(machine)
        except KeyError:
            raise HTTPException(400, f"unknown machine {machine}")
        backend_url = base.rstrip("/")
        # aicore (server.py) má jen /generate; api-wrapper stroje /api/generate
        gen_paths = ["/api/generate", "/generate"]
    else:
        backend_url = BACKEND_URL
        # server.py má jen /generate (bez /api prefixu)
        gen_paths = ["/api/generate", "/generate"]

    await _maybe_refresh_models()
    kind = _kind_for(model)
    if not kind:
        # fallback: pokus o přímé rozlišení podle klíčů
        kind = "tts" if "text" in req else "image"

    prompt = str(req.get("text", req.get("prompt", "")))
    negative_prompt = str(req.get("negative_prompt", ""))
    t0 = time.time()
    status = "ok"
    error = None
    content = b""
    ctype = "application/octet-stream"
    device = ""

    # Zjisti device z backend health (před generací)
    try:
        async with httpx.AsyncClient(timeout=HEALTH_TIMEOUT) as client:
            hr = await client.get(f"{backend_url}/health")
        if hr.status_code == 200:
            hdata = hr.json()
            device = str(hdata.get("loaded_device", "") or "")
    except Exception:
        pass

    try:
        async with httpx.AsyncClient(timeout=GENERATE_TIMEOUT) as client:
            r = None
            last_exc = None
            for path in gen_paths:
                try:
                    r = await client.post(f"{backend_url}{path}", json=req)
                    if r.status_code == 404:
                        continue  # starší backend bez této cesty → zkus další
                    break
                except httpx.ConnectError:
                    raise
            if r is None:
                status = "error"
                error = "backend nemá generate endpoint"
            elif r.status_code != 200:
                status = "error"
                error = r.text[:1000] if r.text else f"HTTP {r.status_code}"
            else:
                content = r.content
                ctype = _sniff_media_type(content, r.headers.get("content-type", ctype))
                # Po úspěšné generaci znovu zjisti device
                try:
                    async with httpx.AsyncClient(timeout=HEALTH_TIMEOUT) as client:
                        hr2 = await client.get(f"{backend_url}/health")
                    if hr2.status_code == 200:
                        device = str(hr2.json().get("loaded_device", "") or device)
                except Exception:
                    pass
    except httpx.ConnectError:
        status = "error"
        error = f"Backend unreachable at {BACKEND_URL}"
    except httpx.TimeoutException:
        status = "error"
        error = f"Generation timed out after {GENERATE_TIMEOUT}s"

    duration_ms = int((time.time() - t0) * 1000)

    output_path = ""
    if status == "ok" and content:
        try:
            OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
            ext_by_ctype = {"image/png": ".png", "image/jpeg": ".jpg", "audio/flac": ".flac",
                            "audio/wav": ".wav", "audio/ogg": ".ogg", "audio/mpeg": ".mp3"}
            suffix = ext_by_ctype.get(ctype, ".png" if kind == "image" else ".wav")
            output_path = str(OUTPUT_DIR / f"{int(t0)}_{uuid.uuid4().hex[:8]}_{kind}{suffix}")
            with open(output_path, "wb") as f:
                f.write(content)
        except OSError as e:
            log.warning("Failed to save output: %s", e)
            output_path = ""

    _record_history(kind, model, prompt, negative_prompt, req, status, error,
                    duration_ms, len(content), device, ctype, output_path, machine)

    if status == "error":
        raise HTTPException(502, error or "Generation failed")

    return Response(content=content, media_type=ctype)


# ── GPU stats ─────────────────────────────────────────────

@app.get("/api/gpu-stats")
async def gpu_stats():
    return {"gpus": await asyncio.to_thread(_gpu_stats)}


# ── Capabilities (HUB — každý stroj hlásí co umí) ─────────

# Jediný zdroj pravdy cc → arch (spec .cmd-tasks/multi-gpu-hub.txt)
CC_ARCH = [
    (6, 1, "pascal"),     # P40, P4000
    (8, 6, "ampere"),     # 3070
    (12, 0, "blackwell"),  # 5060 Ti
]

SERVICES_FILE = Path(os.environ.get("HUB_SERVICES_FILE", "services.yaml"))
CAPS_CACHE_TTL = float(os.environ.get("HUB_CAPS_CACHE_TTL", "5"))
_caps_cache: tuple[float, dict | None] = (0.0, None)


def _arch_for_cc(major: int, minor: int) -> str:
    for maj, mnr, arch in CC_ARCH:
        if major == maj and minor == mnr:
            return arch
    if major >= 8:
        return "ampere+"
    if major >= 6:
        return "pascal"
    return "unknown"


def _machine_info() -> dict:
    try:
        with open("/proc/meminfo") as f:
            ram_mb = int(re.search(r"MemTotal:\s+(\d+)", f.read()).group(1)) // 1024
    except Exception:
        ram_mb = 0
    return {"hostname": socket.gethostname(), "ram_mb": ram_mb,
            "cpu_cores": os.cpu_count() or 0}


def _hub_gpus() -> list[dict]:
    """GPU seznam pro hub — postavené na stávajícím _gpu_stats() XML parsingu + cc→arch."""
    out = []
    for i, g in enumerate(_gpu_stats()):
        name = str(g.get("name", "unknown"))
        cc = _cc_for_name(name)
        major, minor = (cc.split(".") + ["0"])[:2]
        out.append({
            "index": i,
            "name": name,
            "vram_mb": int(g.get("memory_total_mb", 0)),
            "vram_used_mb": int(g.get("memory_used_mb", 0)),
            "vram_free_mb": int(g.get("memory_free_mb", 0)),
            "util_pct": int(g.get("gpu_util_pct", 0)),
            "temp_c": int(g.get("temperature_c", 0)),
            "cc": cc,
            "arch": _arch_for_cc(int(major), int(minor)),
        })
    return out


def _cc_for_name(gpu_name: str) -> str:
    """Fallback cc detekce dle názvu GPU (nvidia-smi -x nevrací compute_cap)."""
    n = gpu_name.lower()
    if "p40" in n or "p4000" in n:
        return "6.1"
    if "3070" in n or "3060" in n or "a10" in n:
        return "8.6"
    if "5060" in n or "5070" in n or "5080" in n or "5090" in n:
        return "12.0"
    return "0.0"


def _hub_services() -> list[dict]:
    if not SERVICES_FILE.exists():
        return []
    try:
        import yaml
        cfg = yaml.safe_load(SERVICES_FILE.read_text()) or {}
    except Exception as e:
        log.warning("services.yaml parse failed: %s", e)
        return []
    out = []
    for svc in cfg.get("services", []):
        entry = {"type": svc["type"], "id": svc.get("id", svc["type"]),
                 "port": svc.get("port"), "running": False}
        if svc.get("backend"):
            entry["backend"] = svc["backend"]
        if svc.get("mode"):
            entry["mode"] = svc["mode"]
        health = svc.get("healthcheck") or (f"http://127.0.0.1:{svc['port']}/health" if svc.get("port") else None)
        if health:
            try:
                r = httpx.get(health, timeout=2)
                entry["running"] = r.status_code == 200
            except Exception:
                entry["running"] = False
        out.append(entry)
    return out


def _capabilities() -> dict:
    global _caps_cache
    ts, cached = _caps_cache
    if cached and time.time() - ts < CAPS_CACHE_TTL:
        return cached
    caps = {
        "machine": _machine_info(),
        "gpus": _hub_gpus(),
        "services": _hub_services(),
        "wrapper_version": app.version,
    }
    _caps_cache = (time.time(), caps)
    return caps


@app.get("/capabilities")
async def capabilities():
    """Stav stroje pro HUB probing (GPU arch/cc/VRAM, služby + running, CPU/RAM)."""
    return await asyncio.to_thread(_capabilities)


# ── History ───────────────────────────────────────────────

@app.get("/api/history")
async def history(limit: int = Query(50, ge=1, le=500),
                  kind: str | None = None, model: str | None = None,
                  status: str | None = None, search: str | None = None):
    q = "SELECT * FROM history WHERE 1=1"
    args: list = []
    if kind:
        q += " AND kind = ?"
        args.append(kind)
    if model:
        q += " AND model = ?"
        args.append(model)
    if status:
        q += " AND status = ?"
        args.append(status)
    if search:
        q += " AND (prompt LIKE ? OR negative_prompt LIKE ? OR model LIKE ?)"
        like = f"%{search}%"
        args.extend([like, like, like])
    q += " ORDER BY id DESC LIMIT ?"
    args.append(limit)
    with _db_lock:
        rows = _get_db().execute(q, args).fetchall()
    return {"history": [dict(r) for r in rows]}


@app.get("/api/history/{hid}")
async def history_detail(hid: int):
    with _db_lock:
        row = _get_db().execute("SELECT * FROM history WHERE id = ?", (hid,)).fetchone()
    if not row:
        raise HTTPException(404, f"History {hid} not found")
    item = dict(row)
    try:
        item["params"] = json.loads(item.get("params") or "{}")
    except json.JSONDecodeError:
        item["params"] = {}
    return item


@app.get("/api/history/{hid}/output")
async def history_output(hid: int):
    with _db_lock:
        row = _get_db().execute("SELECT * FROM history WHERE id = ?", (hid,)).fetchone()
    if not row:
        raise HTTPException(404, f"History {hid} not found")
    path = Path(row["output_path"]) if row["output_path"] else None
    if not path or not path.exists():
        raise HTTPException(404, "Output for this history entry is not available")
    return FileResponse(path, media_type=row["mimetype"] or "application/octet-stream")


@app.delete("/api/history/{hid}")
async def history_delete(hid: int):
    with _db_lock:
        row = _get_db().execute("SELECT output_path FROM history WHERE id = ?", (hid,)).fetchone()
        if not row:
            raise HTTPException(404, f"History {hid} not found")
        if row["output_path"]:
            try:
                Path(row["output_path"]).unlink(missing_ok=True)
            except OSError:
                pass
        _get_db().execute("DELETE FROM history WHERE id = ?", (hid,))
        _get_db().commit()
    return {"status": "ok", "deleted": hid}


@app.get("/api/stats")
async def stats():
    with _db_lock:
        db = _get_db()
        total = db.execute("SELECT COUNT(*) FROM history").fetchone()[0]
        ok = db.execute("SELECT COUNT(*) FROM history WHERE status = 'ok'").fetchone()[0]
        by_kind = {r[0]: r[1] for r in db.execute(
            "SELECT kind, COUNT(*) FROM history GROUP BY kind").fetchall()}
        by_model = {r[0]: r[1] for r in db.execute(
            "SELECT model, COUNT(*) FROM history GROUP BY model").fetchall()}
        avg_ms = db.execute(
            "SELECT AVG(duration_ms) FROM history WHERE status = 'ok'").fetchone()[0]
        templates = db.execute("SELECT COUNT(*) FROM templates").fetchone()[0]
    return {
        "total": total,
        "ok": ok,
        "errors": total - ok,
        "success_rate": round(ok / total * 100, 1) if total else 0,
        "avg_duration_ms": round(avg_ms, 0) if avg_ms is not None else None,
        "by_kind": by_kind,
        "by_model": by_model,
        "templates": templates,
    }


# ── Templates CRUD ────────────────────────────────────────

TEMPLATE_KINDS = {"tts_text", "image_prompt", "negative_prompt", "voice_instruction"}

SEED_TEMPLATES = [
    # TTS texts — CZ
    {"name": "Předpověď počasí (CZ)", "kind": "tts_text", "category": "weather", "language": "cs",
     "model_hint": "moss-tts-v1.5",
     "content": "Dobrý den, vítejte v dnešní předpovědi počasí. Dnes očekáváme polojasno s teplotami kolem dvaceti pěti stupňů Celsia. Odpoledne se mohou vyskytnout přeháňky, zejména v horských oblastech."},
    {"name": "Zprávy úvod (CZ)", "kind": "tts_text", "category": "news", "language": "cs",
     "model_hint": "moss-tts-v1.5",
     "content": "Vážení diváci, přinášíme vám hlavní zprávy dne. Začneme vítáním a pozdravem všem našim posluchačům."},
    {"name": "Podcast intro (CZ)", "kind": "tts_text", "category": "podcast", "language": "cs",
     "model_hint": "moss-local-v1.5",
     "content": "Vítejte u dalšího dílu našeho podcastu. Dnes se budeme věnovat zajímavému tématu, které vás určitě nadchne."},
    {"name": "Výuka (CZ)", "kind": "tts_text", "category": "education", "language": "cs",
     "model_hint": "moss-local-v1.5",
     "content": "V dnešní lekci si povíme o koloběhu vody. Vypařování, kondenzace a srážky společně přesouvají vodu po naší planetě."},
    {"name": "Reklama (CZ)", "kind": "tts_text", "category": "commercial", "language": "cs",
     "model_hint": "moss-tts-v1.5",
     "content": "Objevte novou generaci chytrých zařízení, která vám usnadní každý den. Kvalita, na kterou se můžete spolehnout."},
    {"name": "Audiokniha (CZ)", "kind": "tts_text", "category": "audiobook", "language": "cs",
     "model_hint": "moss-tts-v1.5",
     "content": "Když se dveře konečně otevřely, do místnosti vstoupil cizinec a jeho stín se rozprostřel po celé podlaze."},
    # TTS texts — EN
    {"name": "Weather forecast (EN)", "kind": "tts_text", "category": "weather", "language": "en",
     "model_hint": "moss-tts-v1.5",
     "content": "Good morning, and welcome to today's weather forecast. We expect partly cloudy skies with temperatures around seventy-five degrees Fahrenheit this afternoon."},
    {"name": "News bulletin (EN)", "kind": "tts_text", "category": "news", "language": "en",
     "model_hint": "moss-tts-v1.5",
     "content": "Ladies and gentlemen, here is the news. Our top story this hour: communities across the region prepare for the weekend festival."},
    {"name": "Podcast intro (EN)", "kind": "tts_text", "category": "podcast", "language": "en",
     "model_hint": "moss-tts-v1.5",
     "content": "Welcome back to the show. In this episode we explore what makes a great story, and how you can tell one of your own."},
    {"name": "E-learning (EN)", "kind": "tts_text", "category": "education", "language": "en",
     "model_hint": "moss-tts-v1.5",
     "content": "In this lesson, we will learn about the water cycle. Evaporation, condensation, and precipitation work together to move water around our planet."},
    {"name": "Commercial (EN)", "kind": "tts_text", "category": "commercial", "language": "en",
     "model_hint": "moss-tts-v1.5",
     "content": "Discover the new generation of smart devices that make every day easier. Quality you can rely on."},
    {"name": "Audiobook (EN)", "kind": "tts_text", "category": "audiobook", "language": "en",
     "model_hint": "moss-tts-v1.5",
     "content": "As the door finally opened, a stranger stepped into the room and his shadow stretched across the floor."},
    # Image prompts
    {"name": "Portrét ženy", "kind": "image_prompt", "category": "portrait", "language": None,
     "model_hint": "juggernaut-zimage",
     "content": "Cinematic portrait of a woman, soft studio lighting, shallow depth of field, detailed skin texture, elegant pose, 85mm lens"},
    {"name": "Portrét muže", "kind": "image_prompt", "category": "portrait", "language": None,
     "model_hint": "juggernaut-zimage",
     "content": "Dramatic portrait of an older man with a beard, rim lighting, weathered skin, intense gaze, dark background"},
    {"name": "Horská krajina", "kind": "image_prompt", "category": "landscape", "language": None,
     "model_hint": "flux2-klein-q6k",
     "content": "Majestic alpine landscape at sunrise, snow-capped peaks, misty valley, golden light, ultra detailed"},
    {"name": "Mořská krajina", "kind": "image_prompt", "category": "landscape", "language": None,
     "model_hint": "flux2-klein-q6k",
     "content": "Dramatic ocean scene at sunset, crashing waves against rocks, seagulls, warm orange sky"},
    {"name": "Architektura", "kind": "image_prompt", "category": "architecture", "language": None,
     "model_hint": "flux-schnell-gguf",
     "content": "Modern minimalist house with floor-to-ceiling glass windows, infinity pool, dusk, architectural photography"},
    {"name": "Sci-fi město", "kind": "image_prompt", "category": "scifi", "language": None,
     "model_hint": "qwen-gguf-q5",
     "content": "Futuristic cyberpunk city street at night, neon signs, flying vehicles, rain reflections, cinematic"},
    {"name": "Fantasy les", "kind": "image_prompt", "category": "fantasy", "language": None,
     "model_hint": "z-anime",
     "content": "Enchanted forest with glowing mushrooms and fireflies, ancient trees, volumetric light, fantasy art"},
    {"name": "Produktová fotka", "kind": "image_prompt", "category": "product", "language": None,
     "model_hint": "flux-schnell-gguf",
     "content": "Premium product photography of a sleek wireless headphone on a minimal background, studio lighting"},
    {"name": "Kosmonaut", "kind": "image_prompt", "category": "scifi", "language": None,
     "model_hint": "flux2-klein-q6k",
     "content": "Astronaut floating in space with Earth in background, detailed spacesuit, dramatic lighting"},
    {"name": "Zvíře", "kind": "image_prompt", "category": "wildlife", "language": None,
     "model_hint": "zimage-turbo-gguf",
     "content": "Close-up of a red fox in snowy forest, piercing eyes, fur detail, soft bokeh background"},
    # Negative prompts
    {"name": "Standardní negativ", "kind": "negative_prompt", "category": "general", "language": None,
     "model_hint": None,
     "content": "blurry, low quality, deformed, disfigured, bad anatomy, watermark, text, logo"},
    {"name": "Foto negativ", "kind": "negative_prompt", "category": "photography", "language": None,
     "model_hint": None,
     "content": "cartoon, illustration, painting, lowres, oversaturated, underexposed, noise, grain"},
    {"name": "Anime negativ", "kind": "negative_prompt", "category": "anime", "language": None,
     "model_hint": None,
     "content": "photorealistic, 3d render, lowres, jpeg artifacts, bad hands, extra fingers"},
    {"name": "Architektura negativ", "kind": "negative_prompt", "category": "architecture", "language": None,
     "model_hint": None,
     "content": "people, cars, clutter, warped perspective, tilted, distorted lines"},
    {"name": "Portrét negativ", "kind": "negative_prompt", "category": "portrait", "language": None,
     "model_hint": None,
     "content": "asymmetric face, cross-eyed, extra limbs, plastic skin, doll, mask"},
    # Voice instructions
    {"name": "Moderátor zpráv", "kind": "voice_instruction", "category": "news", "language": "cs",
     "model_hint": "moss-tts-v1.5",
     "content": "Vážný a důvěryhodný hlas hlavního zpravodajství, srozumitelná artikulace, střední tempo."},
    {"name": "Přátelský podcast", "kind": "voice_instruction", "category": "podcast", "language": "cs",
     "model_hint": "moss-local-v1.5",
     "content": "Přátelský, energický a nadšený hlas moderátora podcastu, lehké tempo."},
    {"name": "Trpělivý učitel", "kind": "voice_instruction", "category": "education", "language": "cs",
     "model_hint": "moss-local-v1.5",
     "content": "Trpělivý a přátelský hlas učitele, jasné tempo vhodné pro výuku."},
    {"name": "Klidný muž", "kind": "voice_instruction", "category": "audiobook", "language": "cs",
     "model_hint": "moss-tts-v1.5",
     "content": "Klidný mužský hlas, pomalé tempo, profesionální vypravěč audioknih."},
    {"name": "Energická žena", "kind": "voice_instruction", "category": "commercial", "language": "cs",
     "model_hint": "moss-tts-v1.5",
     "content": "Energický ženský hlas s jasnou výslovností, dynamické tempo, reklamní styl."},
    {"name": "News anchor (EN)", "kind": "voice_instruction", "category": "news", "language": "en",
     "model_hint": "moss-tts-v1.5",
     "content": "Neutral, clear news anchor voice, formal and professional."},
    {"name": "Calm narrator (EN)", "kind": "voice_instruction", "category": "audiobook", "language": "en",
     "model_hint": "moss-tts-v1.5",
     "content": "Calm and soothing narrator voice, steady pace, warm and reassuring."},
    {"name": "Excited host (EN)", "kind": "voice_instruction", "category": "commercial", "language": "en",
     "model_hint": "moss-tts-v1.5",
     "content": "Excited host delivering an energetic and enthusiastic speech with a lively voice."},
]


def _sync_seed_templates():
    db = _get_db()
    for t in SEED_TEMPLATES:
        db.execute(
            "UPDATE templates SET content = ?, category = ?, language = ?, model_hint = ? "
            "WHERE name = ? AND kind = ? AND is_seed = 1",
            (t["content"], t["category"], t["language"], t["model_hint"], t["name"], t["kind"]),
        )
    db.commit()


def _seed_templates():
    with _db_lock:
        db = _get_db()
        cur = db.execute("SELECT COUNT(*) FROM templates WHERE is_seed = 1")
        if cur.fetchone()[0] > 0:
            _sync_seed_templates()
            return {"status": "ok", "seeded": 0, "message": "already seeded"}
        for t in SEED_TEMPLATES:
            db.execute(
                "INSERT INTO templates (name, kind, content, category, language, model_hint, is_seed) "
                "VALUES (?, ?, ?, ?, ?, ?, 1)",
                (t["name"], t["kind"], t["content"], t["category"], t["language"], t["model_hint"]),
            )
        db.commit()
        return {"status": "ok", "seeded": len(SEED_TEMPLATES), "message": "seeded"}


@app.get("/api/templates")
async def list_templates(kind: str | None = None, category: str | None = None,
                         language: str | None = None, model_hint: str | None = None):
    q = "SELECT * FROM templates WHERE 1=1"
    args: list = []
    if kind:
        q += " AND kind = ?"
        args.append(kind)
    if category:
        q += " AND category = ?"
        args.append(category)
    if language:
        q += " AND language = ?"
        args.append(language)
    if model_hint:
        q += " AND model_hint = ?"
        args.append(model_hint)
    q += " ORDER BY is_seed DESC, name"
    with _db_lock:
        rows = _get_db().execute(q, args).fetchall()
    return {"templates": [dict(r) for r in rows]}


@app.post("/api/templates")
async def create_template(payload: dict):
    name = str(payload.get("name", "")).strip()
    kind = str(payload.get("kind", "")).strip()
    content = str(payload.get("content", "")).strip()
    if not name or not content:
        raise HTTPException(400, "name and content are required")
    if kind not in TEMPLATE_KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(TEMPLATE_KINDS)}")
    with _db_lock:
        cur = _get_db().execute(
            "INSERT INTO templates (name, kind, content, category, language, model_hint) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (name, kind, content, payload.get("category"), payload.get("language"),
             payload.get("model_hint")),
        )
        _get_db().commit()
        return {"status": "ok", "id": cur.lastrowid}


@app.put("/api/templates/{tid}")
async def update_template(tid: int, payload: dict):
    name = str(payload.get("name", "")).strip()
    content = str(payload.get("content", "")).strip()
    if not name or not content:
        raise HTTPException(400, "name and content are required")
    kind = str(payload.get("kind", "")).strip()
    if kind and kind not in TEMPLATE_KINDS:
        raise HTTPException(400, f"kind must be one of {sorted(TEMPLATE_KINDS)}")
    with _db_lock:
        cur = _get_db().execute(
            "UPDATE templates SET name = ?, kind = ?, content = ?, category = ?, "
            "language = ?, model_hint = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (name, kind, content, payload.get("category"), payload.get("language"),
             payload.get("model_hint"), tid),
        )
        _get_db().commit()
        if cur.rowcount == 0:
            raise HTTPException(404, f"Template {tid} not found")
    return {"status": "ok", "id": tid}


@app.delete("/api/templates/{tid}")
async def delete_template(tid: int):
    with _db_lock:
        cur = _get_db().execute("DELETE FROM templates WHERE id = ?", (tid,))
        _get_db().commit()
        if cur.rowcount == 0:
            raise HTTPException(404, f"Template {tid} not found")
    return {"status": "ok", "deleted": tid}


@app.post("/api/templates/seed")
async def seed_templates():
    return _seed_templates()


@app.get("/api/templates/export")
async def export_templates():
    with _db_lock:
        rows = _get_db().execute("SELECT * FROM templates").fetchall()
    return {"templates": [dict(r) for r in rows]}


@app.post("/api/templates/import")
async def import_templates(payload: dict):
    items = payload.get("templates", [])
    if not isinstance(items, list):
        raise HTTPException(400, "payload.templates must be a list")
    imported = 0
    with _db_lock:
        db = _get_db()
        for item in items:
            name = str(item.get("name", "")).strip()
            kind = str(item.get("kind", "")).strip()
            content = str(item.get("content", "")).strip()
            if not name or not content or kind not in TEMPLATE_KINDS:
                continue
            db.execute(
                "INSERT INTO templates (name, kind, content, category, language, model_hint, is_seed) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (name, kind, content, item.get("category"), item.get("language"),
                 item.get("model_hint"), 1 if item.get("is_seed") else 0),
            )
            imported += 1
        db.commit()
    return {"status": "ok", "imported": imported}


@app.get("/api/config")
async def config():
    return {
        "backend_url": BACKEND_URL,
        "template_kinds": sorted(TEMPLATE_KINDS),
        "max_template_len": 10000,
    }


# ── Static webapp ─────────────────────────────────────────

class NoCacheStaticFiles(StaticFiles):
    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        resp.headers["Pragma"] = "no-cache"
        resp.headers["Expires"] = "0"
        return resp


if WEBAPP_DIR.exists():
    app.mount("/", NoCacheStaticFiles(directory=str(WEBAPP_DIR), html=True), name="webapp")
else:
    log.warning("WEBAPP_DIR %s not found — webapp not served", WEBAPP_DIR)


# ── Startup ───────────────────────────────────────────────

@app.on_event("startup")
async def _startup():
    _get_db()
    _seed_templates()
    await refresh_models()
    hub_module._load_assignments()
    hub_module.load_desired()
    hub_module._load_cluster()
    hub_module.start_probing()
    hub_module.start_auto_return()
    log.info("comfyui-webapp ready → backend %s, cluster_mode=%s",
             BACKEND_URL, hub_module.cluster_mode())


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8288)
