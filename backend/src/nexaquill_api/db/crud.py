"""Lightweight persistence helpers for chat sessions."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
import re

from sqlalchemy import delete, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from .models import ChatSession, Message, PasswordResetToken, Upload, UploadChunk, User

DEFAULT_USER_EMAIL = "demo@nexa.local"
DEFAULT_USER_NAME = "Prototype User"
DEFAULT_TITLE_TEMPLATE = "Notes - {stamp}"
TITLE_WORD_LIMIT = 8


def get_or_create_user_by_email(
    db: Session,
    *,
    email: str,
    display_name: str | None = None,
) -> User:
    normalized_email = (email or "").strip().lower()
    if not normalized_email:
        raise ValueError("Email is required")

    stmt = select(User).where(User.email == normalized_email)
    user = db.scalars(stmt).first()
    if user:
        if display_name and display_name.strip() and display_name.strip() != (user.display_name or ""):
            user.display_name = display_name.strip()
            db.commit()
            db.refresh(user)
        return user

    user = User(email=normalized_email, display_name=(display_name.strip() if display_name and display_name.strip() else None))
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        existing = db.scalars(stmt).first()
        if existing:
            return existing
        raise
    db.refresh(user)
    return user


def get_user_by_email(db: Session, *, email: str) -> User | None:
    normalized_email = (email or "").strip().lower()
    if not normalized_email:
        return None
    stmt = select(User).where(User.email == normalized_email)
    return db.scalars(stmt).first()


def get_user_by_id(db: Session, *, user_id: uuid.UUID) -> User | None:
    stmt = select(User).where(User.id == user_id)
    return db.scalars(stmt).first()


def create_user_with_password(
    db: Session,
    *,
    email: str,
    password_hash: str,
    display_name: str | None = None,
) -> User:
    normalized_email = (email or "").strip().lower()
    if not normalized_email:
        raise ValueError("Email is required")
    if not password_hash:
        raise ValueError("Password hash is required")

    user = User(
        email=normalized_email,
        display_name=(display_name.strip() if display_name and display_name.strip() else None),
        password_hash=password_hash,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def update_user_password_hash(db: Session, user: User, *, password_hash: str) -> User:
    user.password_hash = password_hash
    db.commit()
    db.refresh(user)
    return user


def invalidate_active_password_reset_tokens(db: Session, *, user_id: uuid.UUID) -> None:
    stmt = delete(PasswordResetToken).where(
        PasswordResetToken.user_id == user_id,
        PasswordResetToken.used_at.is_(None),
    )
    db.execute(stmt)
    db.commit()


def create_password_reset_token(
    db: Session,
    *,
    user: User,
    token_hash: str,
    expires_at: datetime,
) -> PasswordResetToken:
    record = PasswordResetToken(
        user_id=user.id,
        token_hash=token_hash,
        expires_at=expires_at,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    return record


def prune_password_reset_tokens(db: Session, *, user_id: uuid.UUID, now: datetime | None = None) -> None:
    reference = now or datetime.now(tz=timezone.utc)
    stmt = delete(PasswordResetToken).where(
        PasswordResetToken.user_id == user_id,
        or_(PasswordResetToken.used_at.is_not(None), PasswordResetToken.expires_at < reference),
    )
    db.execute(stmt)
    db.commit()


def get_password_reset_token(db: Session, *, token_hash: str) -> PasswordResetToken | None:
    stmt = select(PasswordResetToken).where(PasswordResetToken.token_hash == token_hash)
    return db.scalars(stmt).first()


def mark_password_reset_token_used(db: Session, token: PasswordResetToken) -> PasswordResetToken:
    token.used_at = datetime.now(tz=timezone.utc)
    db.commit()
    db.refresh(token)
    return token


def get_or_create_default_user(db: Session) -> User:
    return get_or_create_user_by_email(db, email=DEFAULT_USER_EMAIL, display_name=DEFAULT_USER_NAME)


def create_session(db: Session, title: str | None = None, *, user: User | None = None) -> ChatSession:
    user = user or get_or_create_default_user(db)
    provided = bool(title and title.strip())
    normalized = _clean_manual_title(title) if provided else _build_auto_title()
    session = ChatSession(
        user_id=user.id,
        title=normalized,
        auto_title=not provided,
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return session


def rename_session(db: Session, session: ChatSession, new_title: str) -> ChatSession:
    session.title = _clean_manual_title(new_title)
    session.auto_title = False
    session.updated_at = datetime.now(tz=timezone.utc)
    db.commit()
    db.refresh(session)
    return session


def list_sessions(db: Session, *, user_id: uuid.UUID | None = None, limit: int = 50) -> list[ChatSession]:
    stmt = (
        select(ChatSession)
        .where(ChatSession.user_id == user_id) if user_id else select(ChatSession)
    )
    stmt = (
        stmt
        .order_by(ChatSession.updated_at.desc())
        .limit(limit)
    )
    return list(db.scalars(stmt))


def get_session(
    db: Session,
    session_id: uuid.UUID,
    *,
    user_id: uuid.UUID | None = None,
) -> ChatSession | None:
    stmt = select(ChatSession).where(ChatSession.id == session_id)
    if user_id:
        stmt = stmt.where(ChatSession.user_id == user_id)
    return db.scalars(stmt).first()


def append_message(
    db: Session,
    session: ChatSession,
    role: str,
    text: str,
) -> Message:
    message = Message(session_id=session.id, role=role, text=text)
    db.add(message)
    session.updated_at = datetime.now(tz=timezone.utc)
    if role == "user" and session.auto_title:
        session.title = _build_title_from_message(text, session.created_at)
        session.auto_title = False
    db.commit()
    db.refresh(message)
    return message


def create_upload(
    db: Session,
    session: ChatSession,
    *,
    filename: str,
    mime_type: str | None,
    file_size: int,
    blob_path: str,
) -> Upload:
    upload = Upload(
        session_id=session.id,
        filename=filename,
        mime_type=mime_type,
        file_size=file_size,
        blob_path=blob_path,
        status="pending",
    )
    db.add(upload)
    db.commit()
    db.refresh(upload)
    return upload


def get_upload(
    db: Session,
    upload_id: uuid.UUID,
    *,
    user_id: uuid.UUID | None = None,
) -> Upload | None:
    stmt = select(Upload).where(Upload.id == upload_id)
    if user_id:
        stmt = stmt.join(ChatSession, Upload.session_id == ChatSession.id).where(ChatSession.user_id == user_id)
    return db.scalars(stmt).first()


def list_uploads_with_status(
    db: Session,
    statuses: list[str],
    *,
    limit: int = 50,
) -> list[Upload]:
    if not statuses:
        return []
    stmt = (
        select(Upload)
        .where(Upload.status.in_(statuses))
        .order_by(Upload.updated_at.desc())
        .limit(limit)
    )
    return list(db.scalars(stmt))


def update_upload_status(
    db: Session,
    upload: Upload,
    *,
    status: str,
    summary: str | None = None,
) -> Upload:
    upload.status = status
    if summary is not None:
        upload.summary = summary
    upload.updated_at = datetime.now(tz=timezone.utc)
    db.commit()
    db.refresh(upload)
    return upload


def replace_upload_chunks(
    db: Session,
    upload_id: uuid.UUID,
    chunks: list[dict[str, object]],
) -> None:
    db.execute(delete(UploadChunk).where(UploadChunk.upload_id == upload_id))
    for chunk in chunks:
        page_number = int(chunk.get("page_number") or 0)
        content = str(chunk.get("content") or "").strip()
        if not content:
            continue
        embedding = chunk.get("embedding")
        if isinstance(embedding, list) and not embedding:
            embedding = None
        db.add(
            UploadChunk(
                upload_id=upload_id,
                page_number=page_number,
                content=content,
                embedding=embedding if isinstance(embedding, list) else None,
            )
        )
    db.commit()


def list_upload_chunks(db: Session, upload_ids: list[uuid.UUID]) -> list[UploadChunk]:
    if not upload_ids:
        return []
    stmt = select(UploadChunk).where(UploadChunk.upload_id.in_(upload_ids))
    return list(db.scalars(stmt))


def list_uploads_by_ids(
    db: Session,
    upload_ids: list[uuid.UUID],
    *,
    user_id: uuid.UUID | None = None,
) -> list[Upload]:
    if not upload_ids:
        return []
    stmt = select(Upload).where(Upload.id.in_(upload_ids))
    if user_id:
        stmt = stmt.join(ChatSession, Upload.session_id == ChatSession.id).where(ChatSession.user_id == user_id)
    return list(db.scalars(stmt))


def delete_upload(db: Session, upload: Upload) -> None:
    db.delete(upload)
    db.commit()


def list_uploads_for_session(
    db: Session,
    session_id: uuid.UUID,
    *,
    user_id: uuid.UUID | None = None,
) -> list[Upload]:
    stmt = select(Upload).where(Upload.session_id == session_id)
    if user_id:
        stmt = stmt.join(ChatSession, Upload.session_id == ChatSession.id).where(ChatSession.user_id == user_id)
    return list(db.scalars(stmt))


def delete_session(db: Session, session_id: uuid.UUID, *, upload_ids: list[uuid.UUID] | None = None) -> None:
    if upload_ids is None:
        upload_ids = [upload.id for upload in list_uploads_for_session(db, session_id)]
    if upload_ids:
        db.execute(delete(UploadChunk).where(UploadChunk.upload_id.in_(upload_ids)))
    db.execute(delete(Upload).where(Upload.session_id == session_id))
    db.execute(delete(Message).where(Message.session_id == session_id))
    db.execute(delete(ChatSession).where(ChatSession.id == session_id))
    db.commit()

def _build_auto_title(reference: datetime | None = None) -> str:
    stamp_source = reference or datetime.now(tz=timezone.utc)
    stamp = stamp_source.strftime("%b %d, %I:%M %p %Z")
    return DEFAULT_TITLE_TEMPLATE.format(stamp=stamp)


def _clean_manual_title(raw_title: str | None) -> str:
    if not raw_title:
        raise ValueError("Title is required")
    cleaned = " ".join(raw_title.strip().split())
    if not cleaned:
        raise ValueError("Title cannot be empty")
    return cleaned


def _build_title_from_message(text: str, fallback_date: datetime | None = None) -> str:
    snippet = " ".join(text.strip().split())
    if not snippet:
        return _build_auto_title(fallback_date)

    sentence_match = re.split(r"[.!?\n]", snippet, maxsplit=1)
    candidate = sentence_match[0].strip() if sentence_match else snippet
    words = candidate.split()
    if len(words) > TITLE_WORD_LIMIT:
        candidate = " ".join(words[:TITLE_WORD_LIMIT]) + "…"
    if candidate and candidate[-1] in ".!?":
        candidate = candidate[:-1]
    if not candidate:
        return _build_auto_title(fallback_date)
    return candidate[:1].upper() + candidate[1:]
