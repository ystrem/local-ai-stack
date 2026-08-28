"""LLM router — proxy /api/proxy/llm/chat pro coding agenty.

FALLBACK CHAIN: aiworker:8080 → aicore:8080 → ollama:11435
"""
import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Dict, Any

import httpx
import services

log = logging.getLogger("hub-ui.llm")

llm_router = APIRouter(prefix="/api/proxy/llm", tags=["llm"])

LLM_TIMEOUT = float(60 * 10)  # 10 min pro dlouhé kompletace


class LLMRequest(BaseModel):
    messages: List[Dict[str, Any]]
    model: str = "auto"   # auto = use default for chosen machine
    temperature: float = 0.7
    max_tokens: int = 4096


@llm_router.post("/chat")
async def chat(req: LLMRequest):
    """LLM chat completion (OpenAI-compat)."""
    target = services.resolve_target("llm")

    # Získej URL
    caps = services.hub._machine_status(target["machine"]).get("caps") or {}
    llm_url = None
    for svc in (caps.get("services") or []):
        if svc.get("id") == target["service"]:
            llm_url = svc.get("url") or caps.get("url")
            break

    if not llm_url:
        raise HTTPException(503, f"LLM služba {target['service']} nemá URL")

    # OpenAI-compat payload
    payload = {
        "model": req.model if req.model != "auto" else "qwen3.8",
        "messages": req.messages,
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
    }
    try:
        async with httpx.AsyncClient(timeout=LLM_TIMEOUT) as client:
            resp = await client.post(f"{llm_url}/v1/chat/completions", json=payload)
        if resp.status_code != 200:
            raise HTTPException(
                resp.status_code,
                f"LLM selhal: {resp.text[:300]}",
            )
        result = resp.json()
        result["served_by"] = target["machine"]
        return result
    except httpx.HTTPError as e:
        raise HTTPException(502, f"LLM unreachable: {e}")


@llm_router.get("/health")
async def health():
    """Health check LLM služeb v clusteru."""
    return services.health_for_kind("llm")
