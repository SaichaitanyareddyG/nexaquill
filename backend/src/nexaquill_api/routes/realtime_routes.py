from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse, PlainTextResponse
from sqlalchemy.orm import Session

from ..db.models import User
from ..db.session import get_db
from ..settings import Settings, get_settings
from ..services.auth_service import get_current_user
from ..services.realtime_service import create_realtime_session, exchange_sdp
from ..services.quota_service import ensure_voice_quota_available, record_voice_usage

logger = logging.getLogger("nexaquill.realtime")
router = APIRouter(prefix="/nexa", tags=["realtime"])


@router.get("/token")
async def get_session_token(
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    name: str | None = None,
) -> JSONResponse:
    ensure_voice_quota_available(user)
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
    db: Session = Depends(get_db),
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
        ensure_voice_quota_available(user)
        answer = await exchange_sdp(settings, offer_sdp, token, model)
    except Exception as exc:
        logger.error("WebRTC exchange failed: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Failed to exchange SDP") from exc
    updated = record_voice_usage(db, user, tokens=settings.VOICE_SESSION_TOKEN_COST)
    quota_header = json.dumps({"limit": updated.voice_tokens_limit, "used": updated.voice_tokens_used})
    response = PlainTextResponse(answer, media_type="application/sdp")
    response.headers["x-nexa-voice-quota"] = quota_header
    return response
