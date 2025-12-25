from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import FastAPI, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.exc import OperationalError as SQLAlchemyOperationalError

from .db import crud
from .db.session import (
    db_status,
    get_session_factory,
    mark_db_unavailable,
    verify_db_connection,
)
from .routes import (
    admin_routes,
    auth_routes,
    health_routes,
    realtime_routes,
    respond_routes,
    session_routes,
    upload_routes,
)
from .services.queue_service import enqueue_upload_job
from .services.upload_service import process_upload_async
from .settings import Settings, get_settings

logger = logging.getLogger("nexaquill")


def configure_logging(settings: Settings) -> None:
    level = getattr(logging, settings.LOG_LEVEL.upper(), logging.INFO)
    log_dir = Path(__file__).resolve().parent.parent.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "nexaquill.log"

    handlers = [logging.StreamHandler(), logging.FileHandler(log_file, encoding="utf-8")]

    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=handlers,
    )


def parse_cors_origins(raw: str) -> list[str]:
    if not raw:
        return []
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings)

    app = FastAPI(
        title="NexaQuill Backend",
        version="0.1.0",
        docs_url="/docs",
        redoc_url="/redoc",
    )

    cors_origins = parse_cors_origins(settings.CORS_ALLOW_ORIGINS)
    if cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=cors_origins,
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    app.include_router(health_routes.router)
    app.include_router(auth_routes.router)
    app.include_router(session_routes.router)
    app.include_router(upload_routes.router)
    app.include_router(respond_routes.router)
    app.include_router(realtime_routes.router)
    app.include_router(admin_routes.router)

    @app.on_event("startup")
    async def on_startup() -> None:  # pragma: no cover - wiring
        verify_db_connection()
        if db_status() is False:
            logger.warning("Database unavailable at startup; sessions/uploads will fail until connectivity is restored.")
            logger.info("Startup complete with log level %s", settings.LOG_LEVEL)
            return

        try:
            SessionLocal = get_session_factory()
            db = SessionLocal()
            pending = crud.list_uploads_with_status(db, ["pending", "processing"], limit=20)
            db.close()
        except Exception as exc:  # pragma: no cover
            logger.warning("Failed to re-queue pending uploads: %s", exc)
            return

        for upload in pending:
            queued = enqueue_upload_job(settings, str(upload.id))
            if not queued:
                asyncio.create_task(process_upload_async(upload.id, settings))
        if pending:
            logger.info("Re-queued %s pending upload(s) for background processing.", len(pending))
        logger.info("Startup complete with log level %s", settings.LOG_LEVEL)

    @app.exception_handler(SQLAlchemyOperationalError)
    async def handle_db_operational_error(
        request,
        exc: SQLAlchemyOperationalError,
    ) -> JSONResponse:
        mark_db_unavailable()
        logger.error("Database operation failed: %s", exc)
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={
                "detail": (
                    "Database unavailable. If you're using Azure Postgres, confirm the server is running and "
                    "your current public IP is allowed in the firewall rules."
                )
            },
        )

    return app


app = create_app()
