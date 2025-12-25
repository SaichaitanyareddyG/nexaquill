from __future__ import annotations

import logging

import asyncio
import json
import uuid
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..db import crud
from ..db.session import get_db
from ..schemas import (
    AdminLoginRequest,
    AdminLoginResponse,
    AdminLogSnapshot,
    AdminUserSummary,
    AdminUserUpdate,
)
from ..settings import Settings, get_settings
from ..services.admin_service import (
    decode_admin_token,
    issue_admin_token,
    log_file_path,
    require_admin,
    validate_admin_credentials,
)

logger = logging.getLogger("nexaquill.admin")
router = APIRouter(prefix="/admin", tags=["admin"])


async def _send_log_payload(websocket: WebSocket, payload: dict[str, Any]) -> None:
    await websocket.send_text(json.dumps(payload, ensure_ascii=False))


def _admin_guard(request: Request, settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return require_admin(request, settings)


def _tail_log(lines: int) -> list[str]:
    path = log_file_path()
    if not path.exists():
        return []
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            handle.seek(0, 2)
            size = handle.tell()
            block_size = 4096
            data = ""
            while size > 0 and data.count("\n") <= lines:
                read_size = min(block_size, size)
                size -= read_size
                handle.seek(size)
                data = handle.read(read_size) + data
            return [line for line in data.splitlines()[-lines:]]
    except Exception as exc:  # pragma: no cover
        logger.error("Failed to tail logs: %s", exc)
        return []


def _read_log_since(cursor: int | None) -> tuple[list[str], int]:
    path = log_file_path()
    if not path.exists():
        return [], 0
    try:
        with path.open("r", encoding="utf-8", errors="ignore") as handle:
            handle.seek(0, 2)
            end = handle.tell()
            if cursor is None or cursor < 0 or cursor > end:
                cursor = max(0, end - 16384)
            handle.seek(cursor)
            data = handle.read()
            lines = data.splitlines()
            return lines, end
    except Exception as exc:  # pragma: no cover
        logger.error("Failed to read log delta: %s", exc)
        return [], 0


@router.post("/login", response_model=AdminLoginResponse)
def admin_login(payload: AdminLoginRequest, settings: Settings = Depends(get_settings)) -> AdminLoginResponse:
    username = payload.username.strip()
    if not validate_admin_credentials(username, payload.password, settings):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid admin credentials")
    token, ttl = issue_admin_token(username, settings)
    return AdminLoginResponse(access_token=token, expires_in=ttl)


@router.get("/users", response_model=list[AdminUserSummary])
def list_users(
    _: dict[str, Any] = Depends(_admin_guard),
    db: Session = Depends(get_db),
    limit: int = 100,
    offset: int = 0,
) -> list[AdminUserSummary]:
    limit = max(1, min(limit, 500))
    offset = max(0, offset)
    records = crud.list_users(db, limit=limit, offset=offset)
    return [AdminUserSummary.model_validate(item) for item in records]


@router.patch("/users/{user_id}", response_model=AdminUserSummary)
def update_user(
    user_id: str,
    payload: AdminUserUpdate,
    _: dict[str, Any] = Depends(_admin_guard),
    db: Session = Depends(get_db),
) -> AdminUserSummary:
    try:
        user_uuid = uuid.UUID(user_id)
    except Exception as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Invalid user id") from exc

    user = crud.get_user_by_id(db, user_id=user_uuid)
    if not user:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User not found")

    updated = crud.update_user_admin_fields(
        db,
        user,
        display_name=payload.display_name,
        is_admin=payload.is_admin,
        chat_tokens_limit=payload.chat_tokens_limit,
        voice_tokens_limit=payload.voice_tokens_limit,
        reset_chat_tokens=bool(payload.reset_chat_tokens),
        reset_voice_tokens=bool(payload.reset_voice_tokens),
    )
    return AdminUserSummary.model_validate(updated)


@router.get("/logs", response_model=AdminLogSnapshot)
def fetch_logs(
    cursor: int | None = None,
    limit: int = 200,
    _: dict[str, Any] = Depends(_admin_guard),
) -> AdminLogSnapshot:
    limit = max(10, min(limit, 500))
    path = log_file_path()
    if not path.exists():
        return AdminLogSnapshot(lines=[], cursor=0)

    lines, next_cursor = _read_log_since(cursor)
    if cursor is None and not lines:
        lines = _tail_log(limit)
        next_cursor = path.stat().st_size if path.exists() else 0
    if cursor is None:
        lines = lines[-limit:]
    return AdminLogSnapshot(lines=lines, cursor=next_cursor)


@router.post("/logs/flush")
async def flush_logs(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> JSONResponse:
    require_admin(request, settings)
    log_file = log_file_path()
    try:
        log_file.write_text("", encoding="utf-8")
    except Exception as exc:  # pragma: no cover
        logger.error("Failed to flush log file: %s", exc)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to flush logs") from exc
    return JSONResponse({"status": "ok", "log_file": str(log_file)})


@router.post("/flush")
async def flush_logs_legacy(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> JSONResponse:
    return await flush_logs(request, settings)


@router.websocket("/logs/ws")
async def logs_websocket(
    websocket: WebSocket,
    token: str,
    settings: Settings = Depends(get_settings),
) -> None:
    try:
        decode_admin_token(token, settings)
    except HTTPException:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    path = log_file_path()
    initial_lines = _tail_log(200)
    cursor = path.stat().st_size if path.exists() else 0
    if initial_lines:
        await _send_log_payload(websocket, {"lines": initial_lines, "cursor": cursor, "reset": True})

    try:
        while True:
            await asyncio.sleep(1)
            lines, new_cursor = _read_log_since(cursor)
            if new_cursor < cursor:
                cursor = 0
                lines, new_cursor = _read_log_since(cursor)
                if lines:
                    await _send_log_payload(websocket, {"lines": lines, "cursor": new_cursor, "reset": True})
                continue
            if lines:
                await _send_log_payload(websocket, {"lines": lines, "cursor": new_cursor})
            cursor = new_cursor
    except WebSocketDisconnect:
        return
    except Exception as exc:  # pragma: no cover
        logger.error("Log websocket error: %s", exc)
        await websocket.close(code=1011)

