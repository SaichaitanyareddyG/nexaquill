from __future__ import annotations

import asyncio
import logging
from typing import Any
from uuid import UUID

import httpx
from azure.ai.formrecognizer import DocumentAnalysisClient
from azure.core.credentials import AzureKeyCredential
from azure.core.exceptions import ResourceNotFoundError
from sqlalchemy.orm import Session

from ..settings import Settings
from ..db import crud
from ..db.session import get_session_factory
from ..storage import get_blob_storage
from .embedding_service import build_embedding_chunks, embed_texts
from .http_service import request_with_retries
from .llm_service import prepare_azure_messages, build_responses_payload, extract_output_text

logger = logging.getLogger("nexaquill.uploads")


def _azure_suggestions_ready(settings: Settings) -> bool:
    return bool(
        settings.AZURE_OPENAI_API_KEY
        and settings.AZURE_OPENAI_ENDPOINT
        and _azure_suggestion_deployment(settings)
    )


def _openai_suggestions_ready(settings: Settings) -> bool:
    return bool(settings.OPENAI_API_KEY and settings.OPENAI_RESPONSES_URL and settings.OPENAI_SUGGEST_MODEL)


def _azure_suggestion_deployment(settings: Settings) -> str:
    return settings.AZURE_OPENAI_DEPLOYMENT_SUGGEST or settings.AZURE_OPENAI_DEPLOYMENT_CHAT


def _azure_headers(settings: Settings) -> dict[str, str]:
    return {
        "api-key": settings.AZURE_OPENAI_API_KEY,
        "Content-Type": "application/json",
    }


def _azure_chat_url(settings: Settings, deployment: str) -> str:
    base = settings.AZURE_OPENAI_ENDPOINT.rstrip("/")
    version = settings.AZURE_OPENAI_API_VERSION or "2025-04-01-preview"
    return f"{base}/openai/deployments/{deployment}/chat/completions?api-version={version}"


def build_upload_prompt(file_descriptions: list[dict[str, Any]], document_text: str | None = None) -> str:
    listing = "\n".join(f"- {f['name']} ({f['type']}, {f['size']} bytes)" for f in file_descriptions)
    prompt = (
        "You are assisting a health-focused assistant prototype called NexaQuill. "
        "Given the following uploaded files, produce a concise summary (<= 3 sentences) "
        "highlighting insights worth mentioning to the user and suggest a gentle next step.\n"
        f"Files:\n{listing}"
    )
    if document_text:
        snippet = document_text.strip()
        if len(snippet) > 2500:
            snippet = snippet[:2500] + "..."
        prompt += f"\nDocument preview (first {len(snippet)} chars):\n{snippet}"
    return prompt


async def summarize_uploads(
    descriptors: list[dict[str, Any]],
    document_text: str | None,
    settings: Settings,
) -> tuple[str, bool]:
    if not (_azure_suggestions_ready(settings) or _openai_suggestions_ready(settings)):
        if document_text:
            preview = document_text.strip()
            if len(preview) > 600:
                preview = preview[:600] + "…"
            return (f"Document preview:\n{preview}", True)
        return ("Upload received. Summaries will appear once AI credentials are configured.", False)

    prompt = build_upload_prompt(descriptors, document_text)
    messages = [
        {
            "role": "system",
            "content": "You summarise uploaded documents for NexaQuill. Provide a concise three-sentence summary and suggest a next step.",
        },
        {"role": "user", "content": prompt},
    ]
    summary_text: str | None = None

    if _azure_suggestions_ready(settings):
        deployment = _azure_suggestion_deployment(settings)
        payload = {
            "messages": prepare_azure_messages(messages),
            "temperature": 0.4,
        }
        try:
            resp = await request_with_retries(
                "POST",
                _azure_chat_url(settings, deployment),
                headers=_azure_headers(settings),
                json=payload,
                timeout=25,
            )
            summary_text = extract_output_text(resp.json())
        except httpx.HTTPError as exc:
            logger.error("Upload summary failed (azure): %s", exc)
        except Exception as exc:  # pragma: no cover
            logger.error("Unexpected upload summary error (azure): %s", exc)

    if summary_text is None and _openai_suggestions_ready(settings):
        headers = {
            "Authorization": f"Bearer {settings.OPENAI_API_KEY}",
            "Content-Type": "application/json",
        }
        payload = build_responses_payload(
            model=settings.OPENAI_SUGGEST_MODEL,
            messages=messages,
        )
        try:
            resp = await request_with_retries(
                "POST",
                settings.OPENAI_RESPONSES_URL,
                headers=headers,
                json=payload,
                timeout=25,
            )
            summary_text = extract_output_text(resp.json())
        except httpx.HTTPError as exc:
            logger.error("Upload summary failed (openai): %s", exc)
        except Exception as exc:  # pragma: no cover
            logger.error("Unexpected upload summary error: %s", exc)

    if summary_text:
        return summary_text.strip(), True
    if document_text:
        preview = document_text.strip()
        if len(preview) > 600:
            preview = preview[:600] + "…"
        return (f"Document preview:\n{preview}", True)
    return ("Upload staged. I will summarise once the AI service responds.", False)


async def extract_text_from_blob(blob_bytes: bytes, settings: Settings) -> str | None:
    endpoint = settings.AZURE_FORM_RECOGNIZER_ENDPOINT
    key = settings.AZURE_FORM_RECOGNIZER_KEY
    if not endpoint or not key:
        return None

    def sync_process() -> str | None:
        with DocumentAnalysisClient(endpoint, AzureKeyCredential(key)) as client:
            poller = client.begin_analyze_document("prebuilt-read", blob_bytes)
            result = poller.result()

        if getattr(result, "content", None):
            return result.content

        paragraphs: list[str] = []
        raw_paragraphs = getattr(result, "paragraphs", None)
        if raw_paragraphs:
            for paragraph in raw_paragraphs:
                para_text = getattr(paragraph, "content", None) or getattr(paragraph, "text", None)
                if para_text:
                    paragraphs.append(para_text)
        if paragraphs:
            return "\n".join(paragraphs)

        lines: list[str] = []
        read_results = getattr(result, "read_results", None)
        if read_results:
            for read_result in read_results:
                for line in getattr(read_result, "lines", []) or []:
                    if line.content:
                        lines.append(line.content)
        return "\n".join(lines) if lines else None

    try:
        text = await asyncio.to_thread(sync_process)
        return text.strip() if text else None
    except Exception as exc:
        logger.warning("Document analysis failed: %s", exc)
        return None


async def extract_pages_from_blob(blob_bytes: bytes, settings: Settings) -> list[dict[str, Any]]:
    endpoint = settings.AZURE_FORM_RECOGNIZER_ENDPOINT
    key = settings.AZURE_FORM_RECOGNIZER_KEY
    if not endpoint or not key:
        return []

    def sync_process() -> list[dict[str, Any]]:
        with DocumentAnalysisClient(endpoint, AzureKeyCredential(key)) as client:
            poller = client.begin_analyze_document("prebuilt-read", blob_bytes)
            result = poller.result()

        pages_payload: list[dict[str, Any]] = []
        raw_pages = getattr(result, "pages", None)
        if not raw_pages:
            content = getattr(result, "content", None)
            if isinstance(content, str) and content.strip():
                pages_payload.append({"page_number": 1, "content": content.strip()})
            return pages_payload

        for index, page in enumerate(raw_pages, start=1):
            page_number = getattr(page, "page_number", None) or index
            lines = getattr(page, "lines", None) or []
            line_texts: list[str] = []
            for line in lines:
                text = getattr(line, "content", None) or getattr(line, "text", None)
                if isinstance(text, str) and text.strip():
                    line_texts.append(text.strip())
            content = "\n".join(line_texts).strip()
            if content:
                pages_payload.append({"page_number": int(page_number), "content": content})
        return pages_payload

    try:
        pages = await asyncio.to_thread(sync_process)
        return pages or []
    except Exception as exc:
        logger.warning("Document analysis failed (pages): %s", exc)
        return []


async def process_upload_async(upload_id: UUID, settings: Settings) -> None:
    SessionLocal = get_session_factory()
    db: Session = SessionLocal()
    upload = None
    try:
        upload = crud.get_upload(db, upload_id)
        if upload is None:
            return
        storage = get_blob_storage(settings)
        if not storage:
            raise RuntimeError("Azure Blob Storage not configured.")
        try:
            blob_bytes = storage.download_blob(upload.blob_path)
        except ResourceNotFoundError:
            message = (
                f"I couldn't find `{upload.filename}` in blob storage (it may not have uploaded successfully). "
                "Please re-upload the file."
            )
            crud.update_upload_status(db, upload, status="error", summary=message)
            session = crud.get_session(db, upload.session_id)
            if session is not None:
                crud.append_message(db, session, "assistant", message)
            return

        pages = await extract_pages_from_blob(blob_bytes, settings)
        if pages:
            chunks = build_embedding_chunks(pages, settings)
            if chunks:
                embeddings = await embed_texts([chunk["content"] for chunk in chunks], settings)
                if embeddings:
                    for chunk, embedding in zip(chunks, embeddings):
                        chunk["embedding"] = embedding
            try:
                crud.replace_upload_chunks(
                    db,
                    upload.id,
                    chunks
                    if chunks
                    else [{"page_number": p["page_number"], "content": p["content"]} for p in pages],
                )
            except Exception as exc:  # pragma: no cover
                logger.warning("Failed to persist upload chunks for %s: %s", upload.id, exc)
            document_text = "\n\n".join(page["content"] for page in pages if page.get("content"))
        else:
            document_text = None

        descriptors = [
            {"name": upload.filename, "size": upload.file_size, "type": upload.mime_type or "unknown"}
        ]
        summary_text, success = await summarize_uploads(descriptors, document_text, settings)
        status_value = "ready" if success else "error"
        crud.update_upload_status(db, upload, status=status_value, summary=summary_text)

        session = crud.get_session(db, upload.session_id)
        if session is None:
            return

        if success:
            message = f"Processed `{upload.filename}`.\n\nSummary:\n{summary_text.strip()}"
        else:
            message = f"I couldn't fully process `{upload.filename}`.\n\n{summary_text.strip()}"
        crud.append_message(db, session, "assistant", message)
    except Exception as exc:  # pragma: no cover
        logger.error("Background upload processing failed for %s: %s", upload_id, exc)
        try:
            if upload is not None:
                crud.update_upload_status(db, upload, status="error", summary="Upload processing failed.")
        except Exception:
            pass
    finally:
        db.close()


def process_upload_job(upload_id: str, settings: Settings) -> None:
    try:
        uuid = UUID(upload_id)
    except Exception:
        logger.warning("Invalid upload id in job: %s", upload_id)
        return
    asyncio.run(process_upload_async(uuid, settings))
