from __future__ import annotations

import logging
from typing import Any

import httpx

from ..settings import Settings

logger = logging.getLogger("nexaquill.realtime")


def azure_realtime_ready(settings: Settings) -> bool:
    return bool(
        settings.AZURE_OPENAI_API_KEY
        and settings.AZURE_OPENAI_REALTIME_SESSIONS_URL
        and settings.AZURE_OPENAI_REALTIME_MODEL
    )


def openai_realtime_ready(settings: Settings) -> bool:
    return bool(settings.OPENAI_API_KEY and settings.OPENAI_REALTIME_SESSION_URL)


async def create_realtime_session(settings: Settings, name: str | None = None) -> dict[str, Any]:
    instructions = "You are NexaQuill, an assistant prototype."
    if name:
        instructions += f" Greet {name} warmly when the session begins."

    if azure_realtime_ready(settings):
        headers = {
            "api-key": settings.AZURE_OPENAI_API_KEY,
            "Content-Type": "application/json",
        }
        payload = {
            "model": settings.AZURE_OPENAI_REALTIME_MODEL,
            "voice": "verse",
            "instructions": instructions,
        }
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(settings.AZURE_OPENAI_REALTIME_SESSIONS_URL, headers=headers, json=payload)
        resp.raise_for_status()
        return resp.json()

    if not openai_realtime_ready(settings):
        return {
            "mock": True,
            "message": "OpenAI credentials not configured. Returning placeholder token.",
            "client_secret": {"value": "mock-session-token"},
            "name": name,
        }

    headers = {
        "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1",
    }
    payload = {
        "model": settings.OPENAI_REALTIME_MODEL,
        "voice": "verse",
        "instructions": instructions,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(settings.OPENAI_REALTIME_SESSION_URL, headers=headers, json=payload)
    resp.raise_for_status()
    return resp.json()


async def exchange_sdp(settings: Settings, offer_sdp: str, token: str, model: str) -> str:
    if azure_realtime_ready(settings):
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/sdp",
            "Accept": "application/sdp",
        }
        target = settings.AZURE_OPENAI_REALTIME_WEBRTC_URL
        if "model=" not in target:
            target = f"{target}&model={model}" if "?" in target else f"{target}?model={model}"
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(target, headers=headers, content=offer_sdp)
        resp.raise_for_status()
        return resp.text

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/sdp",
        "Accept": "application/sdp",
        "OpenAI-Beta": "realtime=v1",
    }
    target = f"{settings.OPENAI_REALTIME_WEBRTC_URL}?model={model}"
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(target, headers=headers, content=offer_sdp)
    resp.raise_for_status()
    return resp.text
