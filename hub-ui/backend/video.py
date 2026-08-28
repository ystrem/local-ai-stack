"""VIDEO router — proxy /api/proxy/video/generate přes ComfyUI (Sana, Anima).

FALLBACK CHAIN: aicore (P40) → aiworker (Blackwell)
"""
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import httpx
import services

log = logging.getLogger("hub-ui.video")

video_router = APIRouter(prefix="/api/proxy/video", tags=["video"])

VIDEO_TIMEOUT = float(60 * 30)  # 30 min — video gen je pomalý


class VideoRequest(BaseModel):
    prompt: str
    model: str = "sana-1600m"
    duration: int = 5  # sekundy
    width: int = 832
    height: int = 1472
    seed: int = 42


@video_router.post("/generate")
async def generate(req: VideoRequest):
    """Video gen přes ComfyUI (image2video workflow)."""
    target = services.resolve_target("video")

    # Získej URL
    caps = services.hub._machine_status(target["machine"]).get("caps") or {}
    comfyui_url = None
    for svc in (caps.get("services") or []):
        if svc.get("id") == target["service"]:
            comfyui_url = svc.get("url") or caps.get("url")
            break

    if not comfyui_url:
        raise HTTPException(503, f"Video služba {target['service']} nemá URL")

    # ComfyUI /generate payload
    payload = req.model_dump()
    try:
        async with httpx.AsyncClient(timeout=VIDEO_TIMEOUT) as client:
            resp = await client.post(f"{comfyui_url}/generate", json=payload)
        if resp.status_code != 200:
            raise HTTPException(
                resp.status_code,
                f"Video gen selhal: {resp.text[:300]}",
            )
        # Binární MP4 v odpovědi
        return Response(
            content=resp.content,
            media_type="video/mp4",
            headers={"X-Served-By": target["machine"]},
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Video engine unreachable: {e}")


@video_router.get("/health")
async def health():
    """Health check video služeb v clusteru."""
    return services.health_for_kind("video")
