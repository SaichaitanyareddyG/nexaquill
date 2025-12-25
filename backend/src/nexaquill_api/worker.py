from __future__ import annotations

import logging
import time

from .settings import get_settings
from .services.queue_service import process_queue_messages
from .services.upload_service import process_upload_job


logger = logging.getLogger("nexaquill.worker")


def main() -> None:
    settings = get_settings()
    logger.info("Starting NexaQuill OCR worker for queue=%s", settings.AZURE_QUEUE_NAME)
    while True:
        processed = process_queue_messages(settings, lambda upload_id: process_upload_job(upload_id, settings))
        if processed == 0:
            time.sleep(2.0)


if __name__ == "__main__":
    main()
