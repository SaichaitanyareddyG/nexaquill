"""Helpers for normalizing SQLAlchemy connection URLs."""

from __future__ import annotations

from sqlalchemy.engine import URL, make_url


def prefer_psycopg_driver(database_url: str) -> str:
    """Force postgres URLs to use the psycopg (v3) driver if none is specified."""
    if not database_url:
        return database_url

    try:
        sa_url: URL = make_url(database_url)
    except Exception:  # pragma: no cover - fallback for malformed URLs
        return database_url

    # Plain `postgresql://` defaults to psycopg2. Switch to the psycopg v3 driver
    # we already ship so users don't need an extra dependency.
    if sa_url.drivername in {"postgresql", "postgres"}:
        sa_url = sa_url.set(drivername="postgresql+psycopg")

    if sa_url.drivername == "postgresql+psycopg2":
        sa_url = sa_url.set(drivername="postgresql+psycopg")

    # render_as_string(..., hide_password=False) keeps credentials intact.
    return sa_url.render_as_string(hide_password=False)
