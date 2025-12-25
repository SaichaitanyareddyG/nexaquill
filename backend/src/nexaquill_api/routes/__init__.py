"""FastAPI routers."""

from . import (
    admin_routes,
    auth_routes,
    health_routes,
    realtime_routes,
    respond_routes,
    session_routes,
    upload_routes,
)

__all__ = [
    "admin_routes",
    "auth_routes",
    "health_routes",
    "realtime_routes",
    "respond_routes",
    "session_routes",
    "upload_routes",
]
