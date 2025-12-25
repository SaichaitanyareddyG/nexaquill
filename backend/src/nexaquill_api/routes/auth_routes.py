"""Email/password authentication endpoints."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..db import crud
from ..db.models import User
from ..db.session import get_db
from ..schemas import (
    AuthForgotPasswordRequest,
    AuthLoginRequest,
    AuthRegisterRequest,
    AuthResetPasswordRequest,
    AuthTokenResponse,
    UserRead,
)
from ..services.auth_service import get_current_user
from ..services.jwt_service import issue_access_token
from ..services.password_service import hash_password, verify_password
from ..services.password_reset_service import (
    build_reset_link,
    dispatch_reset_email,
    issue_password_reset_token,
    verify_password_reset_token,
)
from ..settings import Settings, get_settings

logger = logging.getLogger("nexaquill.auth.routes")
router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=AuthTokenResponse, status_code=status.HTTP_201_CREATED)
def register(
    payload: AuthRegisterRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> AuthTokenResponse:
    email = (payload.email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email is required")

    existing = crud.get_user_by_email(db, email=email)
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email is already registered")

    try:
        password_hash = hash_password(payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    try:
        user = crud.create_user_with_password(
            db,
            email=email,
            password_hash=password_hash,
            display_name=payload.display_name,
        )
    except IntegrityError:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email is already registered") from None

    token, ttl = issue_access_token(
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        settings=settings,
    )
    return AuthTokenResponse(access_token=token, expires_in=ttl, user=UserRead.model_validate(user))


@router.post("/login", response_model=AuthTokenResponse)
def login(
    payload: AuthLoginRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> AuthTokenResponse:
    email = (payload.email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email is required")

    user = crud.get_user_by_email(db, email=email)
    if not user or not user.password_hash:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")

    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")

    token, ttl = issue_access_token(
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        settings=settings,
    )
    return AuthTokenResponse(access_token=token, expires_in=ttl, user=UserRead.model_validate(user))


@router.get("/me", response_model=UserRead)
def me(user: User = Depends(get_current_user)) -> UserRead:
    return UserRead.model_validate(user)


@router.post("/forgot-password", status_code=status.HTTP_202_ACCEPTED)
def forgot_password(
    payload: AuthForgotPasswordRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    email = (payload.email or "").strip().lower()
    if not email:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email is required")

    user = crud.get_user_by_email(db, email=email)
    if not user or not user.password_hash:
        logger.info("Password reset requested for unknown or SSO-only account: %s", email)
        return {"detail": "If that account exists, you will receive reset instructions shortly."}

    token, _record = issue_password_reset_token(db, user=user, settings=settings)
    reset_link = build_reset_link(settings, token)
    dispatch_reset_email(email, reset_link)
    logger.info("Password reset link issued for %s", email)
    return {"detail": "If that account exists, you will receive reset instructions shortly."}


@router.post("/reset-password")
def reset_password(
    payload: AuthResetPasswordRequest,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    token = (payload.token or "").strip()
    record = verify_password_reset_token(db, token=token)
    if not record:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset token")

    user = crud.get_user_by_id(db, user_id=record.user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired reset token")

    try:
        password_hash = hash_password(payload.password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    crud.update_user_password_hash(db, user, password_hash=password_hash)
    crud.mark_password_reset_token_used(db, record)
    crud.prune_password_reset_tokens(db, user_id=user.id)
    logger.info("Password reset completed for %s", user.email)
    return {"detail": "Password updated"}

