"""WebUI registry — compile-time + runtime discovery.

Master rejstřík všech WebUI v clusteru. Hub-UI frontend načte přes
GET /api/webui/registry.
"""
import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any

import httpx
import yaml
from fastapi import APIRouter, HTTPException

log = logging.getLogger("hub-ui.webui-registry")

webui_router = APIRouter(prefix="/api/webui", tags=["webui"])

# Cache (per-machine, TTL = 30s)
_webui_cache: dict[str, dict] = {}
_webui_cache_ts: dict[str, float] = {}
WEBUI_CACHE_TTL = 30  # sekund

# Config soubory
MACHINES_FILE = Path(os.environ.get("HUB_MACHINES_FILE", "machines.yaml"))
SERVICES_FILE = Path(os.environ.get("HUB_SERVICES_FILE", "services.yaml"))


def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return yaml.safe_load(path.read_text()) or {}
    except (OSError, yaml.YAMLError) as e:
        log.warning("Nelze načíst %s: %s", path, e)
        return {}


def _expand_url(url_template: str, machine_host: str) -> str:
    """Expand {machine_ip} → skutečná IP adresa."""
    return url_template.replace("{machine_ip}", machine_host)


def _ping_webui(url: str, ui_type: str) -> bool:
    """Ověř že WebUI odpovídá. True/False (ne raise)."""
    paths = {"swagger": "/docs", "gradio": "/", "native": "/", "iframe": "/"}
    path = paths.get(ui_type, "/")
    target = f"{url.rstrip('/')}{path}"
    try:
        with httpx.Client(timeout=1.5) as client:
            resp = client.get(target)
            return resp.status_code < 500
    except httpx.HTTPError:
        return False


async def get_all_webui() -> list[dict]:
    """Compile-time + runtime WebUI discovery.

    Vrátí všechna WebUI v clusteru — pro každý stroj expanduje {machine_ip}
    z machines.yaml a ověří přes HEAD/GET že běží.
    """
    machines_cfg = _load_yaml(MACHINES_FILE)
    services_cfg = _load_yaml(SERVICES_FILE)
    machines = machines_cfg.get("machines", [])
    services = services_cfg.get("services", [])

    # Mapování machine_id → host (IP nebo hostname)
    machine_hosts = {}
    for m in machines:
        mid = m.get("id")
        # Priorita: host field > URL hostname
        host = m.get("host")
        if not host and m.get("url"):
            from urllib.parse import urlparse
            host = urlparse(m["url"]).hostname
        if mid and host:
            machine_hosts[mid] = host

    results = []
    probes = []  # (full_url, ui_type, svc, mid, webui)

    for svc in services:
        webui = svc.get("webui")
        if not webui or webui is None:
            continue

        url_template = webui.get("url", "")
        ui_type = webui.get("type", "native")

        for mid, host in machine_hosts.items():
            full_url = _expand_url(url_template, host)
            probes.append((full_url, ui_type, svc, mid, webui))

    # Paralelní probe všech WebUI endpointů (asyncio.gather) — ~2s místo ~14s
    async def _probe_one(probe):
        full_url, ui_type, svc, mid, webui = probe
        ok = await asyncio.to_thread(_ping_webui, full_url, ui_type)
        return {
            "id": svc["id"],
            "machine": mid,
            "type": svc.get("type", "unknown"),
            "url": full_url,
            "label": webui.get("label", svc["id"]),
            "icon": webui.get("icon", "🔗"),
            "ui_type": ui_type,
            "running": ok,
            "shared_with": webui.get("shared_with"),
        }

    if probes:
        results = await asyncio.gather(*(_probe_one(p) for p in probes))

    return results


@webui_router.get("/registry")
async def webui_registry():
    """Vrať aktuální WebUI registry pro SPA (refresh každých 30s)."""
    try:
        return await get_all_webui()
    except Exception as e:
        log.exception("WebUI registry selhal")
        raise HTTPException(500, f"WebUI registry error: {e}")


@webui_router.post("/refresh")
async def webui_refresh():
    """Invalidate cache a znovu načti všechna WebUI."""
    _webui_cache.clear()
    _webui_cache_ts.clear()
    return await get_all_webui()
