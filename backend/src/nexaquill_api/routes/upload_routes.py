from __future__ import annotations

import asyncio
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from ..db import crud
from ..db.models import User
from ..db.session import get_db
from ..schemas import UploadCompleteResponse, UploadPresignRequest, UploadPresignResponse
from ..settings import Settings, get_settings
from ..storage import BlobStorageUnavailable, get_blob_storage, require_blob_storage
from ..services.auth_service import get_current_user
from ..services.queue_service import enqueue_upload_job
from ..services.upload_service import process_upload_async

logger = logging.getLogger("nexaquill.uploads")
router = APIRouter(prefix="/uploads", tags=["uploads"])


@router.post("/presign", response_model=UploadPresignResponse, status_code=status.HTTP_201_CREATED)
async def create_upload_presign(
    payload: UploadPresignRequest,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UploadPresignResponse:
    session = crud.get_session(db, payload.session_id, user_id=user.id)
    if session is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Session not found")
    try:
        storage = require_blob_storage(settings)
    except BlobStorageUnavailable as exc:  # pragma: no cover
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc

    blob_name = storage.build_blob_name(session.id, payload.filename)
    mime_type = payload.mime_type or "application/octet-stream"
    upload = crud.create_upload(
        db,
        session,
        filename=payload.filename,
        mime_type=mime_type,
        file_size=payload.file_size,
        blob_path=blob_name,
    )
    upload_url = storage.generate_upload_url(blob_name, content_type=mime_type)
    return UploadPresignResponse(upload_id=upload.id, upload_url=upload_url, blob_path=storage.blob_url(blob_name))


@router.post("/{upload_id}/complete", response_model=UploadCompleteResponse)
async def finalize_upload(
    upload_id: UUID,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UploadCompleteResponse:
    upload = crud.get_upload(db, upload_id, user_id=user.id)
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")

    crud.update_upload_status(db, upload, status="processing")
    queued = enqueue_upload_job(settings, str(upload_id))
    if not queued:
        asyncio.create_task(process_upload_async(upload_id, settings))
    return UploadCompleteResponse.model_validate(upload)


@router.get("/{upload_id}/download")
async def get_upload_download_url(
    upload_id: UUID,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    upload = crud.get_upload(db, upload_id, user_id=user.id)
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")
    if upload.status != "ready":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Upload is not ready for download")
    try:
        storage = require_blob_storage(settings)
    except BlobStorageUnavailable as exc:  # pragma: no cover
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    url = storage.generate_download_url(upload.blob_path)
    return JSONResponse({"download_url": url})


@router.post("/{upload_id}/reprocess", response_model=UploadCompleteResponse)
async def reprocess_upload(
    upload_id: UUID,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UploadCompleteResponse:
    upload = crud.get_upload(db, upload_id, user_id=user.id)
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")
    crud.update_upload_status(db, upload, status="processing")
    queued = enqueue_upload_job(settings, str(upload_id))
    if not queued:
        asyncio.create_task(process_upload_async(upload_id, settings))
    return UploadCompleteResponse.model_validate(upload)


@router.delete("/{upload_id}")
async def delete_upload(
    upload_id: UUID,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    upload = crud.get_upload(db, upload_id, user_id=user.id)
    if upload is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Upload not found")
    storage = get_blob_storage(settings)
    if storage:
        try:
            storage.delete_blob(upload.blob_path)
        except Exception as exc:  # pragma: no cover
            logger.warning("Failed to delete blob %s: %s", upload.blob_path, exc)
    crud.delete_upload(db, upload)
    return JSONResponse({"deleted": True})
