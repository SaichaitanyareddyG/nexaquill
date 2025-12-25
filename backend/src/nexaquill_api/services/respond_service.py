from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse
import ipaddress
from uuid import UUID

import httpx
from sqlalchemy import select, func

from ..settings import Settings
from ..db import crud
from ..db.models import UploadChunk
from ..db.session import get_session_factory
from ..storage import get_blob_storage
from .embedding_service import embed_texts
from .http_service import request_with_retries
from .llm_service import prepare_azure_messages, build_responses_payload, extract_output_text

logger = logging.getLogger("nexaquill.respond")

_URL_CACHE_TTL_SECONDS = 600
_URL_FETCH_LIMIT = 3
_URL_MAX_BYTES = 320_000
_URL_MAX_CHARS = 4000
_url_cache: dict[str, tuple[float, str]] = {}

_STOPWORDS = {
    "a",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "but",
    "by",
    "for",
    "from",
    "has",
    "have",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "of",
    "on",
    "or",
    "our",
    "so",
    "that",
    "the",
    "their",
    "then",
    "there",
    "these",
    "they",
    "this",
    "to",
    "was",
    "we",
    "were",
    "what",
    "when",
    "which",
    "with",
    "you",
    "your",
}


def sanitize_history(raw: Any) -> list[dict[str, str]]:
    if not isinstance(raw, list):
        return []
    history: list[dict[str, str]] = []
    for entry in raw[-8:]:
        if not isinstance(entry, dict):
            continue
        role = entry.get("role")
        text = entry.get("text") or entry.get("content")
        if isinstance(role, str) and isinstance(text, str):
            history.append({"role": role, "text": text})
    return history


def is_learning_prompt(prompt: str) -> bool:
    lowered = prompt.lower()
    keywords = [
        "learn",
        "learning",
        "roadmap",
        "course",
        "syllabus",
        "plan",
        "study",
        "beginner",
        "how do i",
        "how to",
        "guide",
        "tutorial",
    ]
    return any(keyword in lowered for keyword in keywords)


def build_chat_messages(
    prompt: str,
    context: Any,
    *,
    web_context: str | None = None,
    link_context: str | None = None,
    file_context: str | None = None,
    learning_mode: bool = False,
) -> list[dict[str, Any]]:
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": (
                "You are NexaQuill, a calm and encouraging multimodal assistant focused on health, wellness, and productivity. "
                "Adapt response length to the user's intent and question complexity. "
                "Use concise answers for simple questions, and provide longer, structured guidance for learning requests, "
                "open-ended topics, or when the user asks for help, a plan, or an explanation. "
                "When the user wants to learn a topic, include the core sub-topics they should cover, a starter plan, "
                "and 2-4 beginner-friendly resources or practice ideas. "
                "Respond in GitHub-flavored Markdown with clear headings, concise bullet lists, and normal paragraph spacing. "
                "Leave a blank line between sections and between paragraphs. "
                "Use fenced code blocks with a language tag only for multi-line code and put the code on the next line after the fence. "
                "Use inline code for single identifiers or short snippets. "
                "Do not include UI words like 'Copy'. "
                "Keep the tone interactive by ending with one gentle next step or question. "
                f"Today's date is {now}."
            ),
        }
    ]

    if learning_mode:
        messages.append(
            {
                "role": "system",
                "content": (
                    "Use this structure for learning requests:\n"
                    "1) Core topics to cover\n"
                    "2) Starter plan (week-by-week)\n"
                    "3) Resources (2-4)\n"
                    "4) Practice projects (2-4)\n"
                    "5) Next step question"
                ),
            }
        )

    if web_context:
        messages.append(
            {
                "role": "system",
                "content": (
                    "Web sources were fetched for grounding. Use ONLY these sources for factual claims, "
                    "and cite them inline using [1], [2], etc when relevant.\n\n"
                    f"{web_context}"
                ),
            }
        )

    if link_context:
        messages.append(
            {
                "role": "system",
                "content": (
                    "User-provided URLs were fetched. Use ONLY these excerpts for claims about those links, "
                    "and cite them inline using [U1], [U2], etc when relevant.\n\n"
                    f"{link_context}"
                ),
            }
        )

    if file_context:
        messages.append(
            {
                "role": "system",
                "content": (
                    "Uploaded file excerpts were provided. Use ONLY these excerpts for claims about the user's files. "
                    "When you reference a file, cite it inline as (filename pX).\n\n"
                    f"{file_context}"
                ),
            }
        )

    if isinstance(context, list):
        for entry in context[-6:]:
            if not isinstance(entry, dict):
                continue
            role = entry.get("role")
            text = entry.get("text") or entry.get("content")
            if isinstance(role, str) and isinstance(text, str):
                messages.append({"role": role, "content": text})

    messages.append({"role": "user", "content": prompt})
    return messages


def _tokenize(text: str) -> list[str]:
    tokens = re.findall(r"[a-zA-Z][a-zA-Z0-9_-]{2,}", text.lower())
    return [t for t in tokens if t not in _STOPWORDS]


def _score_overlap(query_tokens: set[str], text: str) -> int:
    if not query_tokens:
        return 0
    tokens = set(_tokenize(text))
    return len(query_tokens.intersection(tokens))


async def ground_with_uploads(
    prompt: str,
    upload_ids: list[UUID],
    settings: Settings,
    *,
    user_id: UUID | None = None,
) -> tuple[str | None, list[dict[str, str]]]:
    query_tokens = set(_tokenize(prompt))
    if not upload_ids:
        return None, []

    try:
        SessionLocal = get_session_factory()
        db = SessionLocal()
    except Exception as exc:
        logger.warning("Upload grounding skipped (DB unavailable): %s", exc)
        return None, []

    try:
        uploads = crud.list_uploads_by_ids(db, upload_ids, user_id=user_id)
        ready_uploads = [u for u in uploads if getattr(u, "status", "") == "ready"]
        if not ready_uploads:
            return None, []
        ready_ids = [u.id for u in ready_uploads]

        query_embedding: list[float] | None = None
        embeddings = await embed_texts([prompt], settings)
        if embeddings:
            query_embedding = embeddings[0]

        if query_embedding:
            stmt = (
                select(UploadChunk)
                .where(UploadChunk.upload_id.in_(ready_ids))
                .where(UploadChunk.embedding.isnot(None))
                .order_by(func.cosine_distance(UploadChunk.embedding, query_embedding))
                .limit(6)
            )
            chunks = list(db.scalars(stmt))
        else:
            chunks = crud.list_upload_chunks(db, ready_ids)
    except Exception as exc:
        logger.warning("Upload grounding failed (query): %s", exc)
        return None, []
    finally:
        db.close()

    scored: list[tuple[int, Any]] = []
    if not query_embedding:
        for chunk in chunks:
            content = getattr(chunk, "content", "") or ""
            score = _score_overlap(query_tokens, content)
            if score <= 0:
                continue
            scored.append((score, chunk))
        scored.sort(key=lambda item: item[0], reverse=True)
        top_chunks = [chunk for _, chunk in scored[:6]]
    else:
        top_chunks = chunks

    if not top_chunks:
        return None, []

    upload_by_id = {u.id: u for u in ready_uploads}
    storage = get_blob_storage(settings)
    sources: list[dict[str, str]] = []
    context_chunks: list[str] = []

    for index, chunk in enumerate(top_chunks, start=1):
        upload = upload_by_id.get(getattr(chunk, "upload_id", None))
        if not upload:
            continue
        filename = getattr(upload, "filename", "upload")
        page_number = int(getattr(chunk, "page_number", 1) or 1)
        content = str(getattr(chunk, "content", "") or "").strip()
        if len(content) > 900:
            content = content[:900] + "…"

        download_url = ""
        if storage:
            try:
                download_url = storage.generate_download_url(upload.blob_path)
            except Exception:
                download_url = ""

        label = f"{filename} (p{page_number})"
        if download_url:
            sources.append({"label": label, "url": f"{download_url}#page={page_number}"})
        context_chunks.append(f"[F{index}] {label}\n{content}")

    context = "\n\n".join(context_chunks).strip()
    return (context or None), sources


_URL_PATTERN = re.compile(r"https?://[^\s)>\"]+")


def _extract_urls(text: str) -> list[str]:
    seen: set[str] = set()
    urls: list[str] = []
    for match in _URL_PATTERN.finditer(text):
        raw = match.group(0).rstrip(").,]}")
        if not raw or raw in seen:
            continue
        seen.add(raw)
        urls.append(raw)
        if len(urls) >= _URL_FETCH_LIMIT:
            break
    return urls


def _is_safe_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        return False
    host = parsed.hostname or ""
    if not host:
        return False
    lowered = host.lower()
    if lowered in {"localhost", "127.0.0.1", "0.0.0.0"} or lowered.endswith(".local"):
        return False
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            return False
    except ValueError:
        pass
    return True


def _strip_html(content: str) -> str:
    cleaned = re.sub(r"(?is)<script.*?>.*?</script>", " ", content)
    cleaned = re.sub(r"(?is)<style.*?>.*?</style>", " ", content)
    cleaned = re.sub(r"(?is)<noscript.*?>.*?</noscript>", " ", content)
    cleaned = re.sub(r"(?is)<svg.*?>.*?</svg>", " ", cleaned)
    cleaned = re.sub(r"(?is)<[^>]+>", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


async def _fetch_url_text(url: str) -> str | None:
    cached = _url_cache.get(url)
    now = datetime.now(timezone.utc).timestamp()
    if cached and now - cached[0] < _URL_CACHE_TTL_SECONDS:
        return cached[1]

    headers = {
        "User-Agent": "NexaQuill/1.0 (+https://example.com)",
        "Accept": "text/html, text/plain;q=0.9, */*;q=0.8",
    }
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
            async with client.stream("GET", url, headers=headers) as resp:
                resp.raise_for_status()
                content_type = resp.headers.get("content-type", "").lower()
                if "text/html" not in content_type and "text/plain" not in content_type and "application/json" not in content_type:
                    return None
                chunks: list[bytes] = []
                total = 0
                async for chunk in resp.aiter_bytes():
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > _URL_MAX_BYTES:
                        chunk = chunk[: _URL_MAX_BYTES - (total - len(chunk))]
                        chunks.append(chunk)
                        break
                    chunks.append(chunk)
                raw = b"".join(chunks)
                encoding = resp.encoding or "utf-8"
                text = raw.decode(encoding, errors="ignore")
    except Exception as exc:
        logger.warning("URL fetch failed (%s): %s", url, exc)
        return None

    if not text:
        return None
    if "<html" in text[:1000].lower():
        text = _strip_html(text)
    else:
        text = re.sub(r"\s+", " ", text).strip()

    if not text:
        return None
    if len(text) > _URL_MAX_CHARS:
        text = text[:_URL_MAX_CHARS] + "…"
    _url_cache[url] = (now, text)
    return text


async def ground_with_urls(prompt: str) -> tuple[str | None, list[dict[str, str]]]:
    urls = [url for url in _extract_urls(prompt) if _is_safe_url(url)]
    if not urls:
        return None, []
    sources: list[dict[str, str]] = []
    chunks: list[str] = []
    index = 1
    for url in urls:
        text = await _fetch_url_text(url)
        if not text:
            continue
        sources.append({"label": url, "url": url})
        snippet = text[:900] + ("…" if len(text) > 900 else "")
        chunks.append(f"[U{index}] {url}\n{snippet}")
        index += 1
    if not sources:
        return None, []
    return "\n\n".join(chunks), sources


async def ground_with_web(prompt: str, settings: Settings) -> tuple[str | None, list[dict[str, str]]]:
    if settings.TAVILY_API_KEY.strip():
        return await _ground_with_tavily(prompt, settings.TAVILY_API_KEY.strip())

    endpoint = settings.AZURE_BING_SEARCH_ENDPOINT.strip()
    key = settings.AZURE_BING_SEARCH_KEY.strip()
    if not endpoint or not key:
        return await _ground_with_wikipedia(prompt)

    base = endpoint.rstrip("/")
    url = f"{base}/bing/v7.0/search"
    params = {"q": prompt, "mkt": "en-US", "count": "3", "textDecorations": "false", "textFormat": "Raw"}
    headers = {"Ocp-Apim-Subscription-Key": key}

    try:
        resp = await request_with_retries(
            "GET",
            url,
            headers=headers,
            params=params,
            timeout=10,
        )
        data = resp.json()
    except Exception as exc:
        logger.warning("Web grounding failed: %s", exc)
        return None, []

    items = (data.get("webPages") or {}).get("value") or []
    sources: list[dict[str, str]] = []
    chunks: list[str] = []
    index = 1
    for item in items:
        if not isinstance(item, dict):
            continue
        title = str(item.get("name") or "").strip()
        link = str(item.get("url") or "").strip()
        snippet = str(item.get("snippet") or "").strip()
        if not link:
            continue
        sources.append({"label": title or link, "url": link})
        safe_title = title or link
        chunks.append(f"[{index}] {safe_title}\nURL: {link}\nSnippet: {snippet}")
        index += 1
        if index > 3:
            break

    if not sources:
        return await _ground_with_wikipedia(prompt)
    return "\n\n".join(chunks), sources


async def _ground_with_tavily(prompt: str, api_key: str) -> tuple[str | None, list[dict[str, str]]]:
    url = "https://api.tavily.com/search"
    payload = {
        "api_key": api_key,
        "query": prompt,
        "max_results": 3,
        "include_answer": False,
        "include_raw_content": False,
    }

    try:
        resp = await request_with_retries(
            "POST",
            url,
            json=payload,
            timeout=12,
        )
        data = resp.json()
    except Exception as exc:
        logger.warning("Tavily grounding failed: %s", exc)
        return await _ground_with_wikipedia(prompt)

    results = data.get("results")
    if not isinstance(results, list) or not results:
        return await _ground_with_wikipedia(prompt)

    sources: list[dict[str, str]] = []
    chunks: list[str] = []
    index = 1
    for item in results:
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        link = str(item.get("url") or "").strip()
        snippet = str(item.get("content") or item.get("snippet") or "").strip()
        if not link:
            continue
        sources.append({"label": title or link, "url": link})
        if len(snippet) > 500:
            snippet = snippet[:500] + "…"
        chunks.append(f"[{index}] {title or link}\nURL: {link}\nSnippet: {snippet}")
        index += 1
        if index > 3:
            break

    if not sources:
        return await _ground_with_wikipedia(prompt)
    return "\n\n".join(chunks), sources


async def _ground_with_wikipedia(prompt: str) -> tuple[str | None, list[dict[str, str]]]:
    search_url = "https://en.wikipedia.org/w/api.php"
    params = {"action": "query", "list": "search", "srsearch": prompt, "srlimit": "3", "format": "json"}

    try:
        resp = await request_with_retries(
            "GET",
            search_url,
            params=params,
            timeout=10,
        )
        data = resp.json()
    except Exception as exc:
        logger.warning("Wikipedia grounding failed (search): %s", exc)
        return None, []

    results = ((data.get("query") or {}).get("search") or []) if isinstance(data, dict) else []
    if not results:
        return None, []

    sources: list[dict[str, str]] = []
    chunks: list[str] = []
    index = 1

    for result in results:
        if not isinstance(result, dict):
            continue
        title = str(result.get("title") or "").strip()
        if not title:
            continue
        page_url = f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"

        extract_params = {
            "action": "query",
            "prop": "extracts",
            "explaintext": "1",
            "exintro": "1",
            "titles": title,
            "format": "json",
        }
        try:
            extract_resp = await request_with_retries(
                "GET",
                search_url,
                params=extract_params,
                timeout=10,
            )
            extract_data = extract_resp.json()
            pages = (extract_data.get("query") or {}).get("pages") or {}
            extract_text = ""
            if isinstance(pages, dict) and pages:
                first_page = next(iter(pages.values()))
                if isinstance(first_page, dict):
                    extract_text = str(first_page.get("extract") or "").strip()
        except Exception:
            extract_text = ""

        sources.append({"label": f"Wikipedia: {title}", "url": page_url})
        preview = extract_text
        if len(preview) > 400:
            preview = preview[:400] + "…"
        chunks.append(f"[{index}] Wikipedia: {title}\nURL: {page_url}\nSnippet: {preview}")
        index += 1
        if index > 3:
            break

    if not sources:
        return None, []
    return "\n\n".join(chunks), sources


def log_http_error(exc: httpx.HTTPError, context: str) -> None:
    response = getattr(exc, "response", None)
    if response is not None:
        try:
            body = response.text
        except Exception:  # pragma: no cover
            body = "<unavailable>"
        logger.error("LLM %s failed: %s - %s", context, exc, body[:500])
    else:  # pragma: no cover
        logger.error("LLM %s failed: %s", context, exc)


def azure_chat_ready(settings: Settings) -> bool:
    return bool(
        settings.AZURE_OPENAI_API_KEY
        and settings.AZURE_OPENAI_ENDPOINT
        and settings.AZURE_OPENAI_DEPLOYMENT_CHAT
    )


def azure_realtime_ready(settings: Settings) -> bool:
    return bool(
        settings.AZURE_OPENAI_API_KEY
        and settings.AZURE_OPENAI_REALTIME_SESSIONS_URL
        and settings.AZURE_OPENAI_REALTIME_MODEL
    )


def azure_headers(settings: Settings) -> dict[str, str]:
    return {
        "api-key": settings.AZURE_OPENAI_API_KEY,
        "Content-Type": "application/json",
    }


def azure_chat_url(settings: Settings, deployment: str) -> str:
    base = settings.AZURE_OPENAI_ENDPOINT.rstrip("/")
    version = settings.AZURE_OPENAI_API_VERSION or "2025-04-01-preview"
    return f"{base}/openai/deployments/{deployment}/chat/completions?api-version={version}"


def azure_suggestion_deployment(settings: Settings) -> str:
    return settings.AZURE_OPENAI_DEPLOYMENT_SUGGEST or settings.AZURE_OPENAI_DEPLOYMENT_CHAT


def openai_chat_ready(settings: Settings) -> bool:
    return bool(settings.OPENAI_API_KEY and settings.OPENAI_RESPONSES_URL and settings.OPENAI_CHAT_MODEL)


def openai_suggestions_ready(settings: Settings) -> bool:
    return bool(settings.OPENAI_API_KEY and settings.OPENAI_RESPONSES_URL and settings.OPENAI_SUGGEST_MODEL)


async def stream_azure_chat(
    url: str,
    *,
    headers: dict[str, str],
    payload: dict[str, Any],
    timeout: float = 40,
) -> tuple[str, list[str]]:
    chunks: list[str] = []
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", url, headers=headers, json=payload, timeout=timeout) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data: "):
                    continue
                data = line[6:].strip()
                if data == "[DONE]":
                    break
                try:
                    payload = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = payload.get("choices", [{}])[0].get("delta", {})
                content = delta.get("content") or ""
                if content:
                    chunks.append(content)
    return "".join(chunks), chunks
