"""Pydantic schemas for session persistence endpoints."""

from __future__ import annotations

from datetime import datetime
from uuid import UUID
from typing import Literal

from pydantic import BaseModel, Field


class MessageCreate(BaseModel):
    role: str = Field(..., max_length=16)
    text: str = Field(..., min_length=1)


class MessageRead(BaseModel):
    id: UUID
    role: str
    text: str
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class SessionCreate(BaseModel):
    title: str | None = Field(default=None, max_length=255)


class SessionUpdate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)


class SessionSummary(BaseModel):
    id: UUID
    title: str
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class SessionDetail(SessionSummary):
    user_id: UUID
    messages: list[MessageRead]
    uploads: list["UploadRead"] = []


class UploadRead(BaseModel):
    id: UUID
    session_id: UUID
    filename: str
    mime_type: str | None = None
    file_size: int
    status: str
    summary: str | None = None
    blob_path: str
    created_at: datetime | None = None
    updated_at: datetime | None = None

    model_config = {"from_attributes": True}


class UploadPresignRequest(BaseModel):
    session_id: UUID
    filename: str = Field(..., max_length=255)
    mime_type: str | None = Field(default=None, max_length=120)
    file_size: int = Field(..., gt=0)


class UploadPresignResponse(BaseModel):
    upload_id: UUID
    upload_url: str
    blob_path: str


class UploadCompleteResponse(UploadRead):
    ...


class ExportReference(BaseModel):
    type: str = Field(..., max_length=32)
    label: str | None = Field(default=None, max_length=255)
    link: str | None = Field(default=None, max_length=1024)


class ExportRequest(BaseModel):
    session_id: UUID
    title: str | None = Field(default=None, max_length=255)
    summary: str = Field(..., min_length=1)
    action_items: list[str] = Field(default_factory=list)
    format: Literal["md", "pdf"] = "md"
    references: list[ExportReference] = Field(default_factory=list)


class ExportResponse(BaseModel):
    url: str
    blob_path: str
    expires_in: int
    format: Literal["md", "pdf"]
    references: list[ExportReference] = Field(default_factory=list)


class UserRead(BaseModel):
    id: UUID
    email: str
    display_name: str | None = None
    created_at: datetime | None = None
    is_admin: bool = False
    chat_tokens_limit: int | None = None
    chat_tokens_used: int | None = None
    voice_tokens_limit: int | None = None
    voice_tokens_used: int | None = None
    tokens_reset_at: datetime | None = None

    model_config = {"from_attributes": True}


class AuthRegisterRequest(BaseModel):
    email: str = Field(..., max_length=255)
    password: str = Field(..., min_length=8, max_length=256)
    display_name: str | None = Field(default=None, max_length=120)


class AuthLoginRequest(BaseModel):
    email: str = Field(..., max_length=255)
    password: str = Field(..., min_length=1, max_length=256)


class AuthTokenResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int
    user: UserRead


class AuthForgotPasswordRequest(BaseModel):
    email: str = Field(..., max_length=255)


class AuthResetPasswordRequest(BaseModel):
    token: str = Field(..., min_length=1, max_length=512)
    password: str = Field(..., min_length=8, max_length=256)


class AdminLoginRequest(BaseModel):
    username: str = Field(..., min_length=1, max_length=120)
    password: str = Field(..., min_length=1, max_length=256)


class AdminLoginResponse(BaseModel):
    access_token: str
    token_type: Literal["bearer"] = "bearer"
    expires_in: int


class AdminUserSummary(BaseModel):
    id: UUID
    email: str
    display_name: str | None = None
    is_admin: bool
    chat_tokens_limit: int
    chat_tokens_used: int
    voice_tokens_limit: int
    voice_tokens_used: int
    tokens_reset_at: datetime | None = None
    created_at: datetime | None = None

    model_config = {"from_attributes": True}


class AdminUserUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=120)
    is_admin: bool | None = None
    chat_tokens_limit: int | None = Field(default=None, ge=0)
    voice_tokens_limit: int | None = Field(default=None, ge=0)
    reset_chat_tokens: bool | None = False
    reset_voice_tokens: bool | None = False


class AdminLogSnapshot(BaseModel):
    lines: list[str] = Field(default_factory=list)
    cursor: int = 0
