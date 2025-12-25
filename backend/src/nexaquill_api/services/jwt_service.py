from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import UUID

from fastapi import HTTPException, status

from ..settings import Settings

_ISSUER = "nexaquill"
_AUDIENCE = "nexaquill"


def issuer() -> str:
    return _ISSUER


def audience() -> str:
    return _AUDIENCE


def _secret(settings: Settings) -> str:
    secret = settings.AUTH_JWT_SECRET.strip()
    if not secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Email/password auth is not configured (AUTH_JWT_SECRET).",
        )
    return secret


def issue_access_token(
    *,
    user_id: UUID,
    email: str,
    display_name: str | None,
    settings: Settings,
) -> tuple[str, int]:
    try:
        from jose import jwt
    except Exception as exc:  # pragma: no cover
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="JWT library missing on server.",
        ) from exc

    ttl_seconds = int(settings.AUTH_JWT_TTL_SECONDS or 0)
    if ttl_seconds <= 0:
        ttl_seconds = 60 * 60 * 24 * 7

    now = datetime.now(timezone.utc)
    exp = now + timedelta(seconds=ttl_seconds)
    payload = {
        "iss": issuer(),
        "aud": audience(),
        "sub": str(user_id),
        "email": email,
        "name": display_name or email,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    token = jwt.encode(payload, _secret(settings), algorithm="HS256")
    return token, ttl_seconds


def verify_access_token(token: str, settings: Settings) -> dict[str, Any]:
    try:
        from jose import jwt
        from jose.exceptions import JWTError
    except Exception as exc:  # pragma: no cover
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="JWT library missing on server.",
        ) from exc

    try:
        return jwt.decode(
            token,
            _secret(settings),
            algorithms=["HS256"],
            audience=audience(),
            issuer=issuer(),
            options={"verify_at_hash": False},
        )
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from None

