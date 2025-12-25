from __future__ import annotations

from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException, Request, status

from ..settings import Settings

ADMIN_SCOPE = "nexa:admin"
ADMIN_ALGORITHM = "HS256"


def _admin_signing_secret(settings: Settings) -> str:
    secret = settings.NEXA_SERVICE_SECRET.strip() or settings.AUTH_JWT_SECRET.strip()
    if not secret:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, detail="Admin secret not configured")
    return secret


def validate_admin_credentials(username: str, password: str, settings: Settings) -> bool:
    expected_username = settings.ADMIN_USERNAME.strip()
    expected_password = settings.ADMIN_PASSWORD.strip()
    return username.strip() == expected_username and password == expected_password


def issue_admin_token(username: str, settings: Settings) -> tuple[str, int]:
    try:
        from jose import jwt
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail="JWT support unavailable") from exc

    ttl = max(60, int(settings.ADMIN_TOKEN_TTL_SECONDS))
    now = datetime.now(tz=timezone.utc)
    payload = {
        "sub": username,
        "scope": ADMIN_SCOPE,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl)).timestamp()),
    }
    token = jwt.encode(payload, _admin_signing_secret(settings), algorithm=ADMIN_ALGORITHM)
    return token, ttl


def decode_admin_token(token: str, settings: Settings) -> dict[str, Any]:
    try:
        from jose import jwt
        from jose.exceptions import JWTError
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail="JWT support unavailable") from exc

    secret = _admin_signing_secret(settings)
    try:
        payload = jwt.decode(token, secret, algorithms=[ADMIN_ALGORITHM])
    except JWTError as exc:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Invalid admin token") from exc
    if payload.get("scope") != ADMIN_SCOPE:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Invalid admin token scope")
    return payload


def require_admin(request: Request, settings: Settings) -> dict[str, Any]:
    auth_header = request.headers.get("Authorization", "").strip()
    if auth_header.lower().startswith("bearer "):
        token = auth_header.split(" ", 1)[1].strip()
        if not token:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Admin token required")
        return decode_admin_token(token, settings)

    # Fallback to legacy secret header for compatibility
    provided = request.headers.get("x-nexa-admin-secret", "").strip()
    secret = settings.NEXA_SERVICE_SECRET.strip()
    if provided and secret and provided == secret:
        return {"sub": "legacy", "scope": ADMIN_SCOPE}

    raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Admin authorization required")


def log_file_path() -> Path:
    log_dir = Path(__file__).resolve().parent.parent.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "nexaquill.log"
