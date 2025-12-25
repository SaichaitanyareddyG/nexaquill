from __future__ import annotations

import logging
import re
from typing import Any

import httpx

from ..settings import Settings
from .http_service import request_with_retries

logger = logging.getLogger("nexaquill.embeddings")


def _chunk_text(text: str, *, size: int, overlap: int) -> list[str]:
    cleaned = re.sub(r"\s+", " ", text).strip()
    if not cleaned:
        return []
    chunks: list[str] = []
    start = 0
    while start < len(cleaned):
        end = min(len(cleaned), start + size)
        chunk = cleaned[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end >= len(cleaned):
            break
        start = max(0, end - overlap)
    return chunks


def build_embedding_chunks(
    pages: list[dict[str, Any]],
    settings: Settings,
) -> list[dict[str, Any]]:
    chunks: list[dict[str, Any]] = []
    max_chunks = settings.EMBEDDING_MAX_CHUNKS
    for page in pages:
        if len(chunks) >= max_chunks:
            break
        page_number = int(page.get("page_number") or 1)
        content = str(page.get("content") or "").strip()
        if not content:
            continue
        for part in _chunk_text(
            content,
            size=settings.EMBEDDING_CHUNK_SIZE,
            overlap=settings.EMBEDDING_CHUNK_OVERLAP,
        ):
            chunks.append({"page_number": page_number, "content": part})
            if len(chunks) >= max_chunks:
                break
    return chunks


def _azure_embeddings_ready(settings: Settings) -> bool:
    return bool(
        settings.AZURE_OPENAI_API_KEY
        and settings.AZURE_OPENAI_ENDPOINT
        and settings.AZURE_OPENAI_DEPLOYMENT_EMBEDDING
    )


def _openai_embeddings_ready(settings: Settings) -> bool:
    return bool(settings.OPENAI_API_KEY and settings.OPENAI_EMBEDDING_MODEL)


def _azure_embeddings_url(settings: Settings) -> str:
    base = settings.AZURE_OPENAI_ENDPOINT.rstrip("/")
    version = settings.AZURE_OPENAI_API_VERSION or "2025-04-01-preview"
    deployment = settings.AZURE_OPENAI_DEPLOYMENT_EMBEDDING
    return f"{base}/openai/deployments/{deployment}/embeddings?api-version={version}"


async def embed_texts(texts: list[str], settings: Settings) -> list[list[float]] | None:
    if not texts:
        return []
    if _azure_embeddings_ready(settings):
        payload = {"input": texts}
        headers = {
            "api-key": settings.AZURE_OPENAI_API_KEY,
            "Content-Type": "application/json",
        }
        try:
            resp = await request_with_retries(
                "POST",
                _azure_embeddings_url(settings),
                headers=headers,
                json=payload,
                timeout=25,
            )
            data = resp.json()
            embeddings = [item.get("embedding") for item in data.get("data", [])]
            return [e for e in embeddings if isinstance(e, list)]
        except httpx.HTTPError as exc:
            logger.error("Azure embeddings failed: %s", exc)
        except Exception as exc:  # pragma: no cover
            logger.error("Azure embeddings error: %s", exc)

    if _openai_embeddings_ready(settings):
        headers = {
            "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = {"model": settings.OPENAI_EMBEDDING_MODEL, "input": texts}
        try:
            resp = await request_with_retries(
                "POST",
                settings.OPENAI_EMBEDDINGS_URL,
                headers=headers,
                json=payload,
                timeout=25,
            )
            data = resp.json()
            embeddings = [item.get("embedding") for item in data.get("data", [])]
            return [e for e in embeddings if isinstance(e, list)]
        except httpx.HTTPError as exc:
            logger.error("OpenAI embeddings failed: %s", exc)
        except Exception as exc:  # pragma: no cover
            logger.error("OpenAI embeddings error: %s", exc)

    return None
