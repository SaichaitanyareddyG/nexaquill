from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any
from uuid import UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from sqlalchemy.orm import Session

from ..agent import AgentPipeline, AgentRequest
from ..db.models import User
from ..db.session import get_db
from ..settings import Settings, get_settings
from ..services.auth_service import get_current_user
from ..services.http_service import request_with_retries
from ..services.llm_service import prepare_azure_messages, build_responses_payload, extract_output_text
from ..services.respond_service import (
    sanitize_history,
    ground_with_urls,
    ground_with_web,
    ground_with_uploads,
    build_chat_messages,
    is_learning_prompt,
    azure_chat_ready,
    azure_chat_url,
    azure_headers,
    azure_suggestion_deployment,
    openai_chat_ready,
    openai_suggestions_ready,
    log_http_error,
)
from ..services.quota_service import ensure_chat_quota_available, estimate_chat_usage, record_chat_usage

logger = logging.getLogger("nexaquill.respond")
router = APIRouter(prefix="/nexa", tags=["respond"])

_LANG_FENCE_PATTERN = re.compile(r"```([A-Za-z0-9+-]+)(?=[A-Za-z])")


def _sanitize_markdown(text: str) -> str:
    if not text:
        return text
    text = text.replace("\r\n", "\n")
    text = re.sub(r"([^\n])```", r"\1\n\n```", text)
    text = _LANG_FENCE_PATTERN.sub(r"```\1\n", text)
    text = re.sub(r"```\s+([A-Za-z0-9+-]+)", r"```\1\n", text)
    text = re.sub(r"```([A-Za-z0-9+-]+)[ \t]+", r"```\1\n", text)
    text = re.sub(r"```(?![A-Za-z0-9+\-\n])", "```\n", text)
    parts = text.split("```")
    for i in range(0, len(parts), 2):
        segment_lines = []
        for line in parts[i].split("\n"):
            if line.strip().lower() == "copy code":
                continue
            segment_lines.append(line)
        segment = "\n".join(segment_lines)
        segment = re.sub(r"([^\n])\s*(#{2,6}\s+)", r"\1\n\n\2", segment)
        segment = re.sub(r"\n{3,}", "\n\n", segment)
        parts[i] = segment
    return "```".join(parts)


def _log_markdown_debug(label: str, text: str) -> None:
    if not logger.isEnabledFor(logging.DEBUG):
        return
    preview = text.replace("\n", "\\n")
    if len(preview) > 360:
        preview = preview[:360] + "…"
    logger.debug("%s length=%s preview=%s", label, len(text), preview)


def _format_sse_data(content: str) -> str:
    if not content:
        return ""
    # IMPORTANT: preserve trailing newlines so streamed markdown/code keeps line breaks.
    # `splitlines()` drops a trailing empty line, which causes code to collapse into one line.
    lines = content.replace("\r\n", "\n").split("\n")
    payload = "\n".join(f"data:{line}" for line in lines)
    return f"{payload}\n\n"


def _fallback_suggestions(prefix: str) -> list[str]:
    trimmed = prefix.strip()
    if not trimmed:
        return [
            "Hello! How would you like NexaQuill to help today?",
            "Need a summary, plan, or quick answer?",
            "Try uploading a PDF so I can synthesise it.",
        ]
    parts = trimmed.split()
    lead = " ".join(parts[:6]) if parts else trimmed
    return [
        f"Want to expand on “{lead}”?",
        "Need a quick summary or a next step?",
        "Share a document if you'd like citations.",
    ]


def _parse_suggestions(raw: str) -> list[str]:
    suggestions: list[str] = []
    for line in raw.splitlines():
        cleaned = line.strip().lstrip("-").strip()
        cleaned = cleaned.lstrip("0123456789. ").strip()
        if cleaned:
            suggestions.append(cleaned)
        if len(suggestions) >= 3:
            break
    return suggestions


@router.post("/autocomplete")
async def autocomplete(
    request: Request,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
) -> JSONResponse:
    body = await request.json()
    prefix = (body.get("prefix") or "").strip()

    fallback = _fallback_suggestions(prefix)
    prompt = (
        "Generate three short follow-up suggestions (under 90 characters each) "
        "based on the user's last message. Respond as a numbered list."
    )
    suggestion_messages = [
        {
            "role": "system",
            "content": "You help NexaQuill craft short follow-up suggestions (under 90 characters each). Respond as a numbered list, one suggestion per line.",
        },
        {"role": "user", "content": f"{prompt}\nUser message: {prefix}"},
    ]

    if settings.AZURE_OPENAI_API_KEY and settings.AZURE_OPENAI_ENDPOINT and azure_suggestion_deployment(settings):
        deployment = azure_suggestion_deployment(settings)
        payload = {
            "messages": prepare_azure_messages(suggestion_messages),
            "temperature": 0.4,
        }
        try:
            resp = await request_with_retries(
                "POST",
                azure_chat_url(settings, deployment),
                headers=azure_headers(settings),
                json=payload,
                timeout=20,
            )
            text = extract_output_text(resp.json())
            if text:
                suggestions = _parse_suggestions(text)
                if suggestions:
                    return JSONResponse({"suggestions": suggestions[:3]})
        except httpx.HTTPError as exc:
            log_http_error(exc, "suggestions")

    if not openai_suggestions_ready(settings):
        return JSONResponse({"suggestions": fallback})

    headers = {
        "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = build_responses_payload(
        model=settings.OPENAI_SUGGEST_MODEL,
        messages=suggestion_messages,
    )
    try:
        resp = await request_with_retries(
            "POST",
            settings.OPENAI_RESPONSES_URL,
            headers=headers,
            json=payload,
            timeout=20,
        )
        text = extract_output_text(resp.json())
        suggestions = _parse_suggestions(text) if text else []
        if not suggestions:
            suggestions = fallback
        return JSONResponse({"suggestions": suggestions[:3]})
    except httpx.HTTPError as exc:
        log_http_error(exc, "suggestions")
    except Exception as exc:  # pragma: no cover
        logger.error("Unexpected suggestion error: %s", exc)

    return JSONResponse({"suggestions": fallback})


@router.post("/respond")
async def respond(
    request: Request,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> JSONResponse:
    body = await request.json()
    prompt = (body.get("prompt") or "").strip()
    context_messages = sanitize_history(body.get("context"))
    upload_context = body.get("uploads_context")
    upload_ids_raw = body.get("upload_ids")
    use_web = bool(body.get("use_web"))
    if isinstance(upload_context, str):
        upload_context = upload_context.strip() or None
    else:
        upload_context = None

    fallback = "I'm ready to dive deeper once the AI connection is available. For now, keep sharing details."

    if not (azure_chat_ready(settings) or openai_chat_ready(settings)):
        return JSONResponse({"reply": fallback})

    if not prompt:
        return JSONResponse({"reply": "Let me know what you’d like to focus on and I’ll jump in."})

    ensure_chat_quota_available(user)

    url_context, url_sources = await ground_with_urls(prompt)

    web_sources: list[dict[str, str]] = []
    web_context: str | None = None
    if use_web:
        web_context, web_sources = await ground_with_web(prompt, settings)

    file_sources: list[dict[str, str]] = []
    file_context: str | None = None
    upload_ids: list[UUID] = []
    if isinstance(upload_ids_raw, list):
        for item in upload_ids_raw:
            try:
                upload_ids.append(UUID(str(item)))
            except Exception:
                continue
    if upload_ids:
        file_context, file_sources = await ground_with_uploads(prompt, upload_ids, settings, user_id=user.id)

    pipeline = AgentPipeline()
    agent_output = await pipeline.run(AgentRequest(prompt=prompt, context=context_messages, upload_context=upload_context))
    learning_mode = is_learning_prompt(prompt)
    chat_messages = build_chat_messages(
        agent_output.prompt,
        context_messages,
        web_context=web_context,
        link_context=url_context,
        file_context=file_context,
        learning_mode=learning_mode,
    )

    if azure_chat_ready(settings):
        payload = {
            "messages": prepare_azure_messages(chat_messages),
            "temperature": 0.6,
        }
        try:
            resp = await request_with_retries(
                "POST",
                azure_chat_url(settings, settings.AZURE_OPENAI_DEPLOYMENT_CHAT),
                headers=azure_headers(settings),
                json=payload,
                timeout=25,
            )
            reply = extract_output_text(resp.json())
            if reply:
                reply = reply.strip()
                tokens_used = estimate_chat_usage(prompt, reply)
                updated_user = record_chat_usage(db, user, tokens=tokens_used)
                return JSONResponse(
                    {
                        "reply": reply,
                        "sources": url_sources + web_sources + file_sources,
                        "quota": {
                            "limit": updated_user.chat_tokens_limit,
                            "used": updated_user.chat_tokens_used,
                        },
                    }
                )
        except httpx.HTTPError as exc:
            log_http_error(exc, "respond")
        except Exception as exc:  # pragma: no cover
            logger.error("Unexpected respond error (azure): %s", exc)

    if not openai_chat_ready(settings):
        return JSONResponse({"reply": fallback})

    headers = {
        "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = build_responses_payload(
        model=settings.OPENAI_CHAT_MODEL or settings.OPENAI_SUGGEST_MODEL,
        messages=chat_messages,
    )
    try:
        resp = await request_with_retries(
            "POST",
            settings.OPENAI_RESPONSES_URL,
            headers=headers,
            json=payload,
            timeout=25,
        )
        reply = extract_output_text(resp.json())
        if reply:
            cleaned = _sanitize_markdown(reply.strip())
            _log_markdown_debug("respond.reply", cleaned)
            tokens_used = estimate_chat_usage(prompt, cleaned)
            updated_user = record_chat_usage(db, user, tokens=tokens_used)
            return JSONResponse(
                {
                    "reply": cleaned,
                    "sources": url_sources + web_sources + file_sources,
                    "quota": {
                        "limit": updated_user.chat_tokens_limit,
                        "used": updated_user.chat_tokens_used,
                    },
                }
            )
    except httpx.HTTPError as exc:
        log_http_error(exc, "respond")
    except Exception as exc:  # pragma: no cover
        logger.error("Unexpected respond error: %s", exc)

    cleaned = _sanitize_markdown(fallback)
    _log_markdown_debug("respond.fallback", cleaned)
    return JSONResponse({"reply": cleaned, "sources": url_sources + web_sources + file_sources})


@router.post("/respond/stream")
async def respond_stream(
    request: Request,
    settings: Settings = Depends(get_settings),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    body = await request.json()
    prompt = (body.get("prompt") or "").strip()
    context_messages = sanitize_history(body.get("context"))
    upload_context = body.get("uploads_context")
    upload_ids_raw = body.get("upload_ids")
    use_web = bool(body.get("use_web"))

    if isinstance(upload_context, str):
        upload_context = upload_context.strip() or None
    else:
        upload_context = None

    if not prompt or not (azure_chat_ready(settings) or openai_chat_ready(settings)):
        async def empty() -> Any:
            yield "data:[DONE]\n\n"

        return StreamingResponse(empty(), media_type="text/event-stream")

    ensure_chat_quota_available(user)

    url_context, url_sources = await ground_with_urls(prompt)
    web_sources: list[dict[str, str]] = []
    web_context: str | None = None
    if use_web:
        web_context, web_sources = await ground_with_web(prompt, settings)

    file_sources: list[dict[str, str]] = []
    file_context: str | None = None
    upload_ids: list[UUID] = []
    if isinstance(upload_ids_raw, list):
        for item in upload_ids_raw:
            try:
                upload_ids.append(UUID(str(item)))
            except Exception:
                continue
    if upload_ids:
        file_context, file_sources = await ground_with_uploads(prompt, upload_ids, settings, user_id=user.id)

    pipeline = AgentPipeline()
    agent_output = await pipeline.run(AgentRequest(prompt=prompt, context=context_messages, upload_context=upload_context))
    learning_mode = is_learning_prompt(prompt)
    chat_messages = build_chat_messages(
        agent_output.prompt,
        context_messages,
        web_context=web_context,
        link_context=url_context,
        file_context=file_context,
        learning_mode=learning_mode,
    )

    sources_payload = url_sources + web_sources + file_sources

    async def event_stream() -> Any:
        yield f"event: sources\ndata:{json.dumps(sources_payload)}\n\n"
        raw_reply: list[str] = []
        if azure_chat_ready(settings):
            payload = {
                "messages": prepare_azure_messages(chat_messages),
                "temperature": 0.6,
                "stream": True,
            }
            try:
                async with httpx.AsyncClient(timeout=None) as client:
                    async with client.stream(
                        "POST",
                        azure_chat_url(settings, settings.AZURE_OPENAI_DEPLOYMENT_CHAT),
                        headers=azure_headers(settings),
                        json=payload,
                    ) as resp:
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
                            choices = payload.get("choices") or []
                            if not choices:
                                continue
                            delta = choices[0].get("delta") or {}
                            content = delta.get("content") or ""
                            if content:
                                raw_reply.append(content)
                                yield _format_sse_data(_sanitize_markdown(content))
                yield "data:[DONE]\n\n"
                full_reply = "".join(raw_reply)
                cleaned = _sanitize_markdown(full_reply)
                _log_markdown_debug("respond.stream.azure", cleaned)
                tokens_used = estimate_chat_usage(prompt, cleaned)
                updated_user = record_chat_usage(db, user, tokens=tokens_used)
                yield f"event: quota\ndata:{json.dumps({'limit': updated_user.chat_tokens_limit, 'used': updated_user.chat_tokens_used})}\n\n"
                return
            except Exception as exc:  # pragma: no cover
                logger.warning("Streaming fallback: %s", exc)

        if openai_chat_ready(settings):
            headers = {
                "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
                "Content-Type": "application/json",
            }
            payload = build_responses_payload(
                model=settings.OPENAI_CHAT_MODEL or settings.OPENAI_SUGGEST_MODEL,
                messages=chat_messages,
            )
            try:
                resp = await request_with_retries(
                    "POST",
                    settings.OPENAI_RESPONSES_URL,
                    headers=headers,
                    json=payload,
                    timeout=25,
                )
                reply = extract_output_text(resp.json()) or ""
                cleaned = _sanitize_markdown(reply)
                _log_markdown_debug("respond.stream.openai", cleaned)
                for chunk in _chunk_text(cleaned, 120):
                    yield _format_sse_data(chunk)
                    await asyncio.sleep(0.01)
                if cleaned:
                    tokens_used = estimate_chat_usage(prompt, cleaned)
                    updated_user = record_chat_usage(db, user, tokens=tokens_used)
                    yield f"event: quota\ndata:{json.dumps({'limit': updated_user.chat_tokens_limit, 'used': updated_user.chat_tokens_used})}\n\n"
            except Exception:
                pass
        yield "data:[DONE]\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _chunk_text(text: str, size: int) -> list[str]:
    if not text:
        return []
    return [text[i : i + size] for i in range(0, len(text), size)]
