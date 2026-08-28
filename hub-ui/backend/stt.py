"""STT router — proxy /api/proxy/stt/transcribe přes faster-whisper.

FALLBACK CHAIN: aicore:5007 → aiworker:5007
"""
import logging
from fastapi import APIRouter, HTTPException, UploadFile, File, Form

import httpx
import services

log = logging.getLogger("hub-ui.stt")

stt_router = APIRouter(prefix="/api/proxy/stt", tags=["stt"])

STT_TIMEOUT = float(60 * 10)  # 10 min pro velké audio soubory


@stt_router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = Form("auto")):
    """STT transkripce přes OpenAI-compat API.

    Form-data: audio file, language ("auto" nebo "cs"/"en"/...)
    Returns: {text, segments, language, duration}
    """
    target = services.resolve_target("stt")

    # Získej URL z capabilities
    caps = services.hub._machine_status(target["machine"]).get("caps") or {}
    stt_url = None
    for svc in (caps.get("services") or []):
        if svc.get("id") == target["service"]:
            stt_url = svc.get("url") or caps.get("url")
            break

    if not stt_url:
        raise HTTPException(503, f"STT služba {target['service']} nemá URL")

    # Forward multipart na STT engine
    try:
        content = await audio.read()
        files = {"file": (audio.filename, content, audio.content_type)}
        data = {"language": language}
        async with httpx.AsyncClient(timeout=STT_TIMEOUT) as client:
            resp = await client.post(
                f"{stt_url}/v1/audio/transcriptions",
                files=files,
                data=data,
            )
        if resp.status_code != 200:
            raise HTTPException(
                resp.status_code,
                f"STT selhal: {resp.text[:300]}",
            )
        result = resp.json()
        result["served_by"] = target["machine"]
        return result
    except httpx.HTTPError as e:
        raise HTTPException(502, f"STT unreachable: {e}")


@stt_router.get("/health")
async def health():
    """Health check STT služeb v clusteru."""
    return services.health_for_kind("stt")
