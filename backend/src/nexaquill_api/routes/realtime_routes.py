from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse, PlainTextResponse

from ..db.models import User
from ..settings import Settings, get_settings
from ..services.auth_service import get_current_user
from ..services.realtime_service import create_realtime_session, exchange_sdp

logger = logging.getLogger("nexaquill.realtime")
router = APIRouter(prefix="/nexa", tags=["realtime"])


@router.get("/token")
async def get_session_token(
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    name: str | None = None,
) -> JSONResponse:
    try:
        payload = await create_realtime_session(settings, name=name)
    except Exception as exc:  # pragma: no cover
        logger.error("Realtime session failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Failed to create realtime session") from exc
    return JSONResponse(status_code=status.HTTP_200_OK, content=payload)


@router.post("/sdp")
async def exchange_sdp_route(
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    request: Request = None,
) -> PlainTextResponse:
    body = await request.json()
    offer_sdp: str | None = body.get("offerSdp")
    token: str | None = body.get("token")
    model: str = body.get("model") or settings.AZURE_OPENAI_REALTIME_MODEL or settings.OPENAI_REALTIME_MODEL

    if not offer_sdp:
        raise HTTPException(status_code=400, detail="offerSdp is required")
    if not token:
        raise HTTPException(status_code=400, detail="token is required for realtime exchange")

    try:
        answer = await exchange_sdp(settings, offer_sdp, token, model)
    except Exception as exc:
        logger.error("WebRTC exchange failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Failed to exchange SDP") from exc
    return PlainTextResponse(answer, media_type="application/sdp")
