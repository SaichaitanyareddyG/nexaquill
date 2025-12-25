from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, Request, status

from ..settings import Settings


def require_admin_secret(request: Request, settings: Settings) -> None:
    secret = settings.NEXA_SERVICE_SECRET.strip()
    if not secret:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Admin secret not configured")
    provided = request.headers.get("x-nexa-admin-secret", "")
    if provided != secret:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid admin secret")


def log_file_path() -> Path:
    log_dir = Path(__file__).resolve().parent.parent.parent / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir / "nexaquill.log"
