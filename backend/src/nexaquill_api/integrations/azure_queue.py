from __future__ import annotations

import json
import logging
from typing import Any

from azure.storage.queue import QueueClient

from ..settings import Settings

logger = logging.getLogger("nexaquill.queue")


def get_queue_client(settings: Settings) -> QueueClient | None:
    queue_name = settings.AZURE_QUEUE_NAME.strip()
    if not queue_name:
        return None

    if settings.AZURE_QUEUE_CONNECTION_STRING:
        client = QueueClient.from_connection_string(
            settings.AZURE_QUEUE_CONNECTION_STRING,
            queue_name=queue_name,
        )
    else:
        account_url = settings.AZURE_QUEUE_ACCOUNT_URL or settings.AZURE_STORAGE_ACCOUNT_URL
        account_name = settings.AZURE_QUEUE_ACCOUNT_NAME or settings.AZURE_STORAGE_ACCOUNT_NAME
        account_key = settings.AZURE_QUEUE_ACCOUNT_KEY or settings.AZURE_STORAGE_ACCOUNT_KEY
        if not (account_url and account_name and account_key):
            return None
        account_url = account_url.rstrip("/")
        client = QueueClient(
            account_url=account_url,
            queue_name=queue_name,
            credential=account_key,
        )

    try:
        client.create_queue()
    except Exception:
        # Queue may already exist or be unavailable.
        pass
    return client


def enqueue_upload(settings: Settings, upload_id: str) -> bool:
    client = get_queue_client(settings)
    if client is None:
        return False
    message = json.dumps({"upload_id": upload_id})
    client.send_message(message)
    return True


def decode_message(raw: Any) -> dict[str, Any] | None:
    try:
        if isinstance(raw, str):
            return json.loads(raw)
        if isinstance(raw, bytes):
            return json.loads(raw.decode("utf-8"))
        return json.loads(str(raw))
    except Exception:
        logger.warning("Failed to decode queue message: %s", raw)
        return None
