from __future__ import annotations

import logging
import time
from typing import Any
import uuid

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from ..db import crud
from ..db.models import User
from ..db.session import get_db
from ..settings import Settings, get_settings
from .jwt_service import issuer as nexaq_issuer, verify_access_token

logger = logging.getLogger("nexaquill.auth")
bearing_scheme = HTTPBearer(auto_error=False)

_JWKS_CACHE: dict[str, tuple[float, dict[str, Any]]] = {}
_JWKS_TTL_SECONDS = 6 * 60 * 60
_GOOGLE_JWKS_CACHE: tuple[float, dict[str, Any]] | None = None


def _jwks_url(tenant_id: str) -> str:
    return f"https://login.microsoftonline.com/{tenant_id}/discovery/v2.0/keys"

def _google_jwks_url() -> str:
    return "https://www.googleapis.com/oauth2/v3/certs"


def _issuer(settings: Settings, tenant_id: str) -> str:
    configured = settings.AZURE_AD_ISSUER.strip()
    if configured:
        return configured
    return f"https://login.microsoftonline.com/{tenant_id}/v2.0"


def _get_jwks(tenant_id: str) -> dict[str, Any]:
    now = time.time()
    cached = _JWKS_CACHE.get(tenant_id)
    if cached and now - cached[0] < _JWKS_TTL_SECONDS:
        return cached[1]

    url = _jwks_url(tenant_id)
    try:
        resp = httpx.get(url, timeout=8)
        resp.raise_for_status()
        jwks = resp.json()
    except httpx.RequestError as exc:
        if cached:
            logger.warning("Entra JWKS refresh failed; using cached keys: %s", exc)
            return cached[1]
        raise

    if not isinstance(jwks, dict) or "keys" not in jwks:
        raise ValueError("Invalid JWKS payload from Entra")

    _JWKS_CACHE[tenant_id] = (now, jwks)
    return jwks


def _get_google_jwks() -> dict[str, Any]:
    global _GOOGLE_JWKS_CACHE
    now = time.time()
    if _GOOGLE_JWKS_CACHE and now - _GOOGLE_JWKS_CACHE[0] < _JWKS_TTL_SECONDS:
        return _GOOGLE_JWKS_CACHE[1]

    try:
        resp = httpx.get(_google_jwks_url(), timeout=8)
        resp.raise_for_status()
        jwks = resp.json()
    except httpx.RequestError as exc:
        if _GOOGLE_JWKS_CACHE:
            logger.warning("Google JWKS refresh failed; using cached keys: %s", exc)
            return _GOOGLE_JWKS_CACHE[1]
        raise

    if not isinstance(jwks, dict) or "keys" not in jwks:
        raise ValueError("Invalid JWKS payload from Google")

    _GOOGLE_JWKS_CACHE = (now, jwks)
    return jwks


def _verify_entra_id_token(token: str, settings: Settings) -> dict[str, Any]:
    tenant_id = settings.AZURE_AD_TENANT_ID.strip()
    client_id = settings.AZURE_AD_CLIENT_ID.strip()
    if not tenant_id or not client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SSO is not configured (AZURE_AD_TENANT_ID/AZURE_AD_CLIENT_ID).",
        )

    try:
        from jose import jwt
        from jose.exceptions import JWTError
    except Exception as exc:  # pragma: no cover
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="JWT library missing on server.",
        ) from exc

    try:
        header = jwt.get_unverified_header(token)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from None

    kid = str(header.get("kid") or "")
    try:
        jwks = _get_jwks(tenant_id)
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SSO provider unavailable. Please retry shortly.",
        ) from exc
    keys = jwks.get("keys") or []
    key = next((item for item in keys if isinstance(item, dict) and item.get("kid") == kid), None)
    if not key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown token key") from None

    try:
        return jwt.decode(
            token,
            key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=_issuer(settings, tenant_id),
            options={"verify_at_hash": False},
        )
    except JWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from None


def _verify_google_id_token(token: str, settings: Settings) -> dict[str, Any]:
    client_id = settings.GOOGLE_OAUTH_CLIENT_ID.strip()
    if not client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Google SSO is not configured (GOOGLE_OAUTH_CLIENT_ID).",
        )

    try:
        from jose import jwt
        from jose.exceptions import JWTError
    except Exception as exc:  # pragma: no cover
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="JWT library missing on server.",
        ) from exc

    try:
        header = jwt.get_unverified_header(token)
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from None

    kid = str(header.get("kid") or "")
    try:
        jwks = _get_google_jwks()
    except httpx.RequestError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="SSO provider unavailable. Please retry shortly.",
        ) from exc
    keys = jwks.get("keys") or []
    key = next((item for item in keys if isinstance(item, dict) and item.get("kid") == kid), None)
    if not key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown token key") from None

    issuers = ("https://accounts.google.com", "accounts.google.com")
    for issuer in issuers:
        try:
            return jwt.decode(
                token,
                key,
                algorithms=["RS256"],
                audience=client_id,
                issuer=issuer,
                options={"verify_at_hash": False},
            )
        except JWTError:
            continue
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from None


def _select_and_verify_id_token(token: str, settings: Settings) -> dict[str, Any]:
    try:
        from jose import jwt
    except Exception:  # pragma: no cover
        return _verify_entra_id_token(token, settings)

    try:
        claims = jwt.get_unverified_claims(token)
    except Exception:
        return _verify_entra_id_token(token, settings)

    iss = str(claims.get("iss") or "")
    if iss == nexaq_issuer():
        return verify_access_token(token, settings)
    if "accounts.google.com" in iss:
        return _verify_google_id_token(token, settings)
    return _verify_entra_id_token(token, settings)


def _extract_email(claims: dict[str, Any]) -> str | None:
    for key in ("preferred_username", "email", "upn"):
        value = claims.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    return None


def _extract_name(claims: dict[str, Any]) -> str | None:
    value = claims.get("name")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearing_scheme),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> User:
    mode = settings.AUTH_MODE
    if mode == "disabled":
        return crud.get_or_create_default_user(db)

    if credentials is None:
        if mode == "required":
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")
        return crud.get_or_create_default_user(db)

    token = credentials.credentials
    claims = _select_and_verify_id_token(token, settings)
    if str(claims.get("iss") or "") == nexaq_issuer():
        sub = claims.get("sub")
        try:
            user_id = sub if isinstance(sub, str) else ""
            user_uuid = uuid.UUID(user_id)
        except Exception:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token") from None
        user = crud.get_user_by_id(db, user_id=user_uuid)
        if not user:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid bearer token")
        return user
    email = _extract_email(claims)
    if not email:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token missing email claim")
    name = _extract_name(claims)
    user = crud.get_or_create_user_by_email(db, email=email, display_name=name)
    return user
