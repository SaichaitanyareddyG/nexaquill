from __future__ import annotations

from typing import Iterable

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from ..db import crud
from ..db.models import User

VOICE_SESSION_FALLBACK_TOKENS = 600

_ESTIMATE_DIVISOR = 4


def _estimate_tokens_from_text(parts: Iterable[str]) -> int:
    total = 0
    for part in parts:
        if not part:
            continue
        total += len(part)
    if total <= 0:
        return 0
    return max(1, total // _ESTIMATE_DIVISOR)


def ensure_chat_quota_available(user: User) -> None:
    limit = max(0, int(user.chat_tokens_limit or 0))
    if limit and user.chat_tokens_used >= limit:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Chat token limit reached. Start a new session or ask an admin to raise your quota.",
        )


def estimate_chat_usage(prompt: str, reply: str | None = None, *extras: str) -> int:
    parts = [prompt]
    if reply:
        parts.append(reply)
    parts.extend(extras)
    return _estimate_tokens_from_text(parts)


def record_chat_usage(db: Session, user: User, *, tokens: int) -> User:
    if tokens <= 0:
        return user
    return crud.add_chat_token_usage(db, user, amount=tokens)


def ensure_voice_quota_available(user: User) -> None:
    limit = max(0, int(user.voice_tokens_limit or 0))
    if limit and user.voice_tokens_used >= limit:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Voice token limit reached. Disable voice or ask an admin to raise your quota.",
        )


def record_voice_usage(db: Session, user: User, *, tokens: int | None = None) -> User:
    amount = tokens if tokens and tokens > 0 else VOICE_SESSION_FALLBACK_TOKENS
    return crud.add_voice_token_usage(db, user, amount=amount)
*** End of File