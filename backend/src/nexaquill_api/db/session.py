"""SQLAlchemy session helpers."""

from __future__ import annotations

from typing import Generator

import logging

from sqlalchemy import create_engine, text
from sqlalchemy.orm import DeclarativeBase, sessionmaker
from sqlalchemy.pool import NullPool

from ..settings import get_settings
from .url import prefer_psycopg_driver
from sqlalchemy.engine import make_url

logger = logging.getLogger("nexaquill.db")


class Base(DeclarativeBase):
    """Base declarative class."""


_ENGINE = None
_SESSION_FACTORY: sessionmaker | None = None
_DB_LABEL: str | None = None
_DB_OK: bool | None = None


def _describe_url(database_url: str) -> str:
    """Return a password-scrubbed version of the DSN for logging."""
    try:
        parsed = make_url(database_url)
        return parsed.set(password="***").render_as_string(hide_password=False)
    except Exception:  # pragma: no cover - defensive logging helper
        return "<invalid>"


def get_engine():
    global _ENGINE, _DB_LABEL  # pragma: no mutate - we intentionally cache the engine
    if _ENGINE is None:
        database_url = prefer_psycopg_driver(get_settings().DATABASE_URL)
        if not database_url:
            raise RuntimeError("DATABASE_URL is not configured.")
        _DB_LABEL = _describe_url(database_url)
        logger.info("Creating SQLAlchemy engine for %s", _DB_LABEL)
        connect_args: dict[str, object] = {}
        try:
            parsed = make_url(database_url)
            if parsed.drivername.startswith("postgresql"):
                connect_args["connect_timeout"] = 6
        except Exception:  # pragma: no cover - best-effort configuration
            connect_args = {}
        _ENGINE = create_engine(
            database_url,
            pool_pre_ping=True,
            poolclass=NullPool,
            connect_args=connect_args,
        )
    return _ENGINE


def get_session_factory() -> sessionmaker:
    global _SESSION_FACTORY  # pragma: no mutate - caching factory
    if _SESSION_FACTORY is None:
        _SESSION_FACTORY = sessionmaker(bind=get_engine(), autoflush=False, autocommit=False)
    return _SESSION_FACTORY


def get_db() -> Generator:
    SessionLocal = get_session_factory()
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def verify_db_connection() -> None:
    """Eagerly ping the database so startup logs show connection status."""
    global _DB_OK
    engine = get_engine()
    label = _DB_LABEL or "<unknown>"
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        logger.info("Database connection OK for %s", label)
        _DB_OK = True
    except Exception:
        logger.exception("Database connection failed for %s", label)
        _DB_OK = False


def mark_db_unavailable() -> None:
    global _DB_OK
    _DB_OK = False


def db_status() -> bool | None:
    return _DB_OK
