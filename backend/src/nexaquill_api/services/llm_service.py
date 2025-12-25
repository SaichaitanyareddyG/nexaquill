from __future__ import annotations

from typing import Any


def wrap_text_message(role: str, text: str, *, content_type: str = "input_text") -> dict[str, Any]:
    return {
        "role": role,
        "content": [{"type": content_type, "text": text}],
    }


def prepare_responses_messages(messages: list[dict[str, str]]) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    for message in messages:
        role = message.get("role") or "user"
        text = str(message.get("content") or "")
        content_type = "output_text" if role == "assistant" else "input_text"
        prepared.append(wrap_text_message(role, text, content_type=content_type))
    return prepared


def prepare_azure_messages(messages: list[dict[str, str]]) -> list[dict[str, Any]]:
    prepared: list[dict[str, Any]] = []
    for message in messages:
        text = str(message.get("content") or "")
        prepared.append(
            {
                "role": message.get("role") or "user",
                "content": [{"type": "text", "text": text}],
            }
        )
    return prepared


def build_responses_payload(
    *,
    model: str,
    messages: list[dict[str, str]],
    temperature: float | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"model": model, "input": prepare_responses_messages(messages)}
    if temperature is not None:
        payload["temperature"] = temperature
    return payload


def extract_output_text(data: dict[str, Any]) -> str | None:
    output = data.get("output")
    if isinstance(output, list) and output:
        for item in output:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "message":
                content = item.get("content") or []
                if isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "output_text":
                            text = part.get("text")
                            if isinstance(text, str):
                                return text
    # Azure/OpenAI chat completions payloads
    choices = data.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else None
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                return content
        delta = choices[0].get("delta") if isinstance(choices[0], dict) else None
        if isinstance(delta, dict):
            content = delta.get("content")
            if isinstance(content, str):
                return content
    return None
