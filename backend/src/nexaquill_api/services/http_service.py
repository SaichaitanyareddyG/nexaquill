from __future__ import annotations

import asyncio
from typing import Any

import httpx

_RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def _retry_delay_seconds(response: httpx.Response | None, base_delay: float) -> float:
    if response is None:
        return base_delay
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        try:
            value = float(retry_after)
            if value > 0:
                return value
        except ValueError:
            pass
    return base_delay


async def request_with_retries(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
    json: dict[str, Any] | None = None,
    timeout: float = 25,
    max_attempts: int = 3,
) -> httpx.Response:
    delay = 1.2
    last_exc: httpx.HTTPError | None = None
    for attempt in range(max_attempts):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.request(method, url, headers=headers, params=params, json=json)
            if resp.status_code in _RETRYABLE_STATUS and attempt < max_attempts - 1:
                await asyncio.sleep(_retry_delay_seconds(resp, delay))
                delay = min(delay * 2, 8.0)
                continue
            resp.raise_for_status()
            return resp
        except httpx.HTTPError as exc:
            last_exc = exc
            if attempt < max_attempts - 1:
                await asyncio.sleep(delay)
                delay = min(delay * 2, 8.0)
                continue
            break
    if last_exc:
        raise last_exc
    raise httpx.HTTPError("Request failed without response.")
