"""Session-related endpoints."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session

from ..db import crud
from ..db.models import ChatSession, Message, Upload, User
from ..db.session import get_db
from ..settings import Settings, get_settings
from ..services.auth_service import get_current_user
from ..storage import get_blob_storage
from ..schemas import MessageCreate, SessionCreate, SessionDetail, SessionUpdate

router = APIRouter(prefix="/sessions", tags=["sessions"])
logger = logging.getLogger("nexaquill.sessions")


@router.get("/", response_model=list[SessionDetail])
def list_sessions(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return recent sessions for the active user."""

    logger.debug("Listing sessions")
    sessions = crud.list_sessions(db, user_id=user.id)
    return [_serialize_session(session, include_messages=True) for session in sessions]


@router.post("/", response_model=SessionDetail, status_code=status.HTTP_201_CREATED)
def create_session(
    payload: SessionCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Create a fresh chat session."""

    logger.info("Creating new session title=%s", payload.title or "<auto>")
    session = crud.create_session(db, payload.title, user=user)
    return _serialize_session(session, include_messages=True)


@router.get("/{session_id}", response_model=SessionDetail)
def get_session(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Fetch a single session with messages."""

    session = crud.get_session(db, session_id, user_id=user.id)
    if session is None:
        logger.warning("Session %s not found for detail fetch", session_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    return _serialize_session(session, include_messages=True)


@router.post(
    "/{session_id}/messages",
    response_model=SessionDetail,
    status_code=status.HTTP_201_CREATED,
)
def add_message(
    session_id: uuid.UUID,
    payload: MessageCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Append a message to a session and return the updated transcript."""

    session = crud.get_session(db, session_id, user_id=user.id)
    if session is None:
        logger.warning("Session %s not found when adding message", session_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    logger.info("Appending %s message to session %s", payload.role, session_id)
    crud.append_message(db, session, payload.role, payload.text)
    db.refresh(session)
    return _serialize_session(session, include_messages=True)


@router.patch("/{session_id}", response_model=SessionDetail)
def rename_session(
    session_id: uuid.UUID,
    payload: SessionUpdate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Rename a session and return the updated record."""

    session = crud.get_session(db, session_id, user_id=user.id)
    if session is None:
        logger.warning("Session %s not found when renaming", session_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    logger.info("Renaming session %s to %s", session_id, payload.title)
    try:
        updated = crud.rename_session(db, session, payload.title)
    except ValueError as exc:  # pragma: no cover - validation guard
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return _serialize_session(updated, include_messages=True)


@router.get("/{session_id}/export")
def export_session(
    session_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Return a serialisable snapshot of a session suitable for downloads."""

    session = crud.get_session(db, session_id, user_id=user.id)
    if session is None:
        logger.warning("Session %s not found for export", session_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    logger.info("Exporting session %s", session_id)
    return _serialize_session(session, include_messages=True)


@router.delete("/{session_id}")
def delete_session(
    session_id: uuid.UUID,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Delete a session along with its messages, uploads, and OCR chunks."""

    session = crud.get_session(db, session_id, user_id=user.id)
    if session is None:
        logger.warning("Session %s not found for delete", session_id)
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")

    uploads = crud.list_uploads_for_session(db, session_id, user_id=user.id)
    storage = get_blob_storage(settings)
    if storage:
        for upload in uploads:
            try:
                storage.delete_blob(upload.blob_path)
            except Exception as exc:  # pragma: no cover - defensive logging
                logger.warning("Failed to delete blob %s: %s", upload.blob_path, exc)

    crud.delete_session(db, session_id, upload_ids=[upload.id for upload in uploads])
    return {"deleted": True}


def _serialize_session(session: ChatSession, include_messages: bool = False) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": session.id,
        "title": session.title,
        "user_id": session.user_id,
        "created_at": session.created_at,
        "updated_at": session.updated_at,
        "uploads": [_serialize_upload(u) for u in sorted(session.uploads, key=lambda item: item.created_at or datetime.min)],
    }
    if include_messages:
        payload["messages"] = [_serialize_message(m) for m in _sorted_messages(session.messages)]
    return payload


def _serialize_message(message: Message) -> dict[str, Any]:
    created = message.created_at or datetime.utcnow()
    return {
        "id": message.id,
        "role": message.role,
        "text": message.text,
        "created_at": created,
    }


def _sorted_messages(messages: list[Message]) -> list[Message]:
    return sorted(messages, key=lambda m: m.created_at or datetime.min)


def _serialize_upload(upload: Upload) -> dict[str, Any]:
    return {
        "id": upload.id,
        "session_id": upload.session_id,
        "filename": upload.filename,
        "mime_type": upload.mime_type,
        "file_size": upload.file_size,
        "status": upload.status,
        "summary": upload.summary,
        "blob_path": upload.blob_path,
        "created_at": upload.created_at,
        "updated_at": upload.updated_at,
    }
