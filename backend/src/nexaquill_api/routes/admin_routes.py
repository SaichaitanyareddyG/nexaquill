from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse

from ..settings import Settings, get_settings
from ..services.admin_service import log_file_path, require_admin_secret

logger = logging.getLogger("nexaquill.admin")
router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/flush")
async def flush_logs(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> JSONResponse:
    require_admin_secret(request, settings)
    log_file = log_file_path()
    try:
        log_file.write_text("", encoding="utf-8")
    except Exception as exc:  # pragma: no cover
        logger.error("Failed to flush log file: %s", exc)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to flush logs") from exc
    return JSONResponse({"status": "ok", "log_file": str(log_file)})
