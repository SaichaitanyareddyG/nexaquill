from __future__ import annotations

import logging
from typing import Callable

from ..settings import Settings
from ..integrations.azure_queue import decode_message, get_queue_client

logger = logging.getLogger("nexaquill.queue")


def enqueue_upload_job(settings: Settings, upload_id: str) -> bool:
    from ..integrations.azure_queue import enqueue_upload

    try:
        return enqueue_upload(settings, upload_id)
    except Exception as exc:  # pragma: no cover - network guard
        logger.warning("Failed to enqueue upload %s: %s", upload_id, exc)
        return False


def process_queue_messages(
    settings: Settings,
    handler: Callable[[str], None],
    *,
    visibility_timeout: int | None = None,
    max_messages: int = 4,
) -> int:
    client = get_queue_client(settings)
    if client is None:
        return 0
    count = 0
    timeout = visibility_timeout or settings.AZURE_QUEUE_VISIBILITY_TIMEOUT
    for message in client.receive_messages(messages_per_page=max_messages, visibility_timeout=timeout):
        payload = decode_message(message.content)
        upload_id = payload.get("upload_id") if payload else None
        if isinstance(upload_id, str):
            try:
                handler(upload_id)
            except Exception as exc:  # pragma: no cover - worker guard
                logger.error("Queue handler failed for %s: %s", upload_id, exc)
        try:
            client.delete_message(message)
        except Exception as exc:  # pragma: no cover - defensive cleanup
            logger.warning("Failed to delete queue message: %s", exc)
        count += 1
    return count
