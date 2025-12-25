from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy.orm import Session

from ..db import crud
from ..db.models import PasswordResetToken, User
from ..settings import Settings

logger = logging.getLogger("nexaquill.auth.password_reset")

_RESET_TOKEN_BYTES = 32


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def issue_password_reset_token(
    db: Session,
    *,
    user: User,
    settings: Settings,
) -> tuple[str, PasswordResetToken]:
    """Create a single active reset token for the supplied user."""
    crud.prune_password_reset_tokens(db, user_id=user.id)
    crud.invalidate_active_password_reset_tokens(db, user_id=user.id)

    token = secrets.token_urlsafe(_RESET_TOKEN_BYTES)
    token_hash = _hash_token(token)

    ttl_minutes = max(settings.AUTH_PASSWORD_RESET_TOKEN_TTL_MINUTES, 1)
    expires_at = datetime.now(tz=timezone.utc) + timedelta(minutes=ttl_minutes)

    record = crud.create_password_reset_token(db, user=user, token_hash=token_hash, expires_at=expires_at)
    return token, record


def verify_password_reset_token(
    db: Session,
    *,
    token: str,
) -> PasswordResetToken | None:
    if not token:
        return None
    token_hash = _hash_token(token)
    record = crud.get_password_reset_token(db, token_hash=token_hash)
    if not record:
        return None
    now = datetime.now(tz=timezone.utc)
    if record.used_at is not None:
        return None
    if record.expires_at < now:
        return None
    return record


def build_reset_link(settings: Settings, token: str) -> str:
    template = settings.AUTH_PASSWORD_RESET_URL.strip()
    if template:
        if "{token}" in template:
            return template.replace("{token}", token)
        separator = "&" if "?" in template else "?"
        return f"{template}{separator}token={token}"
    return f"http://localhost:3000/reset-password?token={token}"


def dispatch_reset_email(email: str, reset_link: str) -> None:
    """Emit the reset link. Replace with real email integration when available."""
    logger.info("Password reset link for %s: %s", email, reset_link)