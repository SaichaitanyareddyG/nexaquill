from __future__ import annotations

from fastapi import APIRouter, Depends

from ..db.session import db_status
from ..settings import Settings, get_settings
from ..services.respond_service import azure_chat_ready, openai_chat_ready, openai_suggestions_ready, azure_suggestion_deployment
from ..services.realtime_service import azure_realtime_ready, openai_realtime_ready

router = APIRouter()


@router.get("/healthz", summary="Liveness probe")
async def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/nexa/status")
async def nexa_status(settings: Settings = Depends(get_settings)) -> dict[str, bool]:
    suggestions_ready = bool(
        settings.AZURE_OPENAI_API_KEY
        and settings.AZURE_OPENAI_ENDPOINT
        and azure_suggestion_deployment(settings)
    ) or openai_suggestions_ready(settings)
    respond_ready = azure_chat_ready(settings) or openai_chat_ready(settings)
    realtime_ready = azure_realtime_ready(settings) or openai_realtime_ready(settings)
    return {
        "db": bool(db_status()),
        "realtime": realtime_ready,
        "suggestions": suggestions_ready,
        "respond": respond_ready,
    }
