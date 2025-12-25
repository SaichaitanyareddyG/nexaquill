from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

_ALGORITHM = "pbkdf2_sha256"
_DEFAULT_ITERATIONS = 310_000
_SALT_BYTES = 16
_HASH_BYTES = 32


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("utf-8").rstrip("=")


def _b64decode(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("utf-8"))


def validate_password(password: str) -> None:
    if not isinstance(password, str) or not password:
        raise ValueError("Password is required")
    if len(password) < 8:
        raise ValueError("Password must be at least 8 characters")


def hash_password(password: str, *, iterations: int = _DEFAULT_ITERATIONS) -> str:
    validate_password(password)
    salt = secrets.token_bytes(_SALT_BYTES)
    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        iterations,
        dklen=_HASH_BYTES,
    )
    return f"{_ALGORITHM}${iterations}${_b64encode(salt)}${_b64encode(derived)}"


def verify_password(password: str, stored_hash: str) -> bool:
    if not password or not stored_hash:
        return False
    try:
        algorithm, iterations_str, salt_b64, derived_b64 = stored_hash.split("$", 3)
        if algorithm != _ALGORITHM:
            return False
        iterations = int(iterations_str)
        salt = _b64decode(salt_b64)
        expected = _b64decode(derived_b64)
    except Exception:
        return False

    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        iterations,
        dklen=len(expected),
    )
    return hmac.compare_digest(derived, expected)

