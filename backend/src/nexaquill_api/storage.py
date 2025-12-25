"""
Utilities for working with Azure Blob Storage uploads.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import Optional

from azure.core.exceptions import ResourceExistsError, ResourceNotFoundError
from azure.storage.blob import BlobClient, BlobSasPermissions, BlobServiceClient, generate_blob_sas

from .settings import Settings


class BlobStorageUnavailable(RuntimeError):
    """Raised when blob storage is not configured."""


class AzureBlobStorage:
    def __init__(
        self,
        *,
        account_url: str,
        account_name: str,
        account_key: str,
        container: str,
        upload_expiry_minutes: int = 10,
        download_expiry_minutes: int = 5,
    ) -> None:
        self._account_url = account_url.rstrip("/")
        self._account_name = account_name
        self._account_key = account_key
        self._container = container
        self._upload_expiry = timedelta(minutes=max(upload_expiry_minutes, 1))
        self._download_expiry = timedelta(minutes=max(download_expiry_minutes, 1))
        self._service_client = BlobServiceClient(account_url=self._account_url, credential=self._account_key)
        self._container_client = self._service_client.get_container_client(container)
        try:
            self._container_client.create_container()
        except ResourceExistsError:
            pass

    @property
    def container_url(self) -> str:
        return f"{self._account_url}/{self._container}"

    def build_blob_name(self, session_id: uuid.UUID, filename: str) -> str:
        safe_name = re.sub(r"[^A-Za-z0-9._-]+", "-", filename).strip("-") or "upload"
        blob_id = uuid.uuid4()
        return f"{session_id}/{blob_id}-{safe_name}"

    def blob_url(self, blob_name: str) -> str:
        return f"{self.container_url}/{blob_name}"

    def generate_upload_url(self, blob_name: str, *, content_type: str | None = None) -> str:
        expiry = _utcnow() + self._upload_expiry
        sas = generate_blob_sas(
            account_name=self._account_name,
            container_name=self._container,
            blob_name=blob_name,
            account_key=self._account_key,
            permission=BlobSasPermissions(write=True, create=True),
            expiry=expiry,
            content_type=content_type,
        )
        return f"{self.blob_url(blob_name)}?{sas}"

    def download_blob(self, blob_name: str) -> bytes:
        blob_client = self._container_client.get_blob_client(blob_name)
        blob: BlobClient = blob_client
        downloader = blob.download_blob()
        return downloader.readall()

    def upload_bytes(self, blob_name: str, data: bytes, *, content_type: str = "application/octet-stream") -> None:
        blob_client = self._container_client.get_blob_client(blob_name)
        blob_client.upload_blob(data, overwrite=True, content_type=content_type)

    def generate_download_url(self, blob_name: str) -> str:
        expiry = _utcnow() + self._download_expiry
        sas = generate_blob_sas(
            account_name=self._account_name,
            container_name=self._container,
            blob_name=blob_name,
            account_key=self._account_key,
            permission=BlobSasPermissions(read=True),
            expiry=expiry,
        )
        return f"{self.blob_url(blob_name)}?{sas}"

    def delete_blob(self, blob_name: str) -> None:
        blob_client = self._container_client.get_blob_client(blob_name)
        try:
            blob_client.delete_blob()
        except ResourceNotFoundError:
            return

    @property
    def download_ttl_seconds(self) -> int:
        return int(self._download_expiry.total_seconds())


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@lru_cache(maxsize=None)
def _storage_from_config(
    account_url: str,
    account_name: str,
    account_key: str,
    container: str,
    upload_ttl: int,
    download_ttl: int,
) -> AzureBlobStorage:
    return AzureBlobStorage(
        account_url=account_url,
        account_name=account_name,
        account_key=account_key,
        container=container,
        upload_expiry_minutes=upload_ttl,
        download_expiry_minutes=download_ttl,
    )


def get_blob_storage(settings: Settings) -> Optional[AzureBlobStorage]:
    if not (
        settings.AZURE_STORAGE_ACCOUNT_URL
        and settings.AZURE_STORAGE_ACCOUNT_NAME
        and settings.AZURE_STORAGE_ACCOUNT_KEY
        and settings.AZURE_STORAGE_CONTAINER
    ):
        return None
    return _storage_from_config(
        settings.AZURE_STORAGE_ACCOUNT_URL,
        settings.AZURE_STORAGE_ACCOUNT_NAME,
        settings.AZURE_STORAGE_ACCOUNT_KEY,
        settings.AZURE_STORAGE_CONTAINER,
        settings.AZURE_STORAGE_UPLOAD_TTL_MINUTES,
        settings.AZURE_STORAGE_DOWNLOAD_TTL_MINUTES,
    )


def require_blob_storage(settings: Settings) -> AzureBlobStorage:
    storage = get_blob_storage(settings)
    if storage is None:
        raise BlobStorageUnavailable("Azure Blob Storage is not configured")
    return storage
