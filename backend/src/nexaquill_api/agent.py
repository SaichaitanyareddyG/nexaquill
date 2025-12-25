"""Lightweight orchestration pipeline for NexaQuill conversations."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


@dataclass
class AgentRequest:
    prompt: str
    context: list[dict[str, str]]
    upload_context: str | None = None


@dataclass
class PlanStep:
    tool: str
    objective: str


@dataclass
class ToolResult:
    name: str
    output: str


@dataclass
class AgentResponse:
    prompt: str
    route: "InputRoute"
    tool_notes: str | None = None


class InputRoute(str, Enum):
    TEXT_ONLY = "text_only"
    ATTACHMENT_ONLY = "attachment_only"
    ATTACHMENT_PLUS_TEXT = "attachment_plus_text"


class InputRouter:
    """Classify an incoming request so we can pick the right tools."""

    def route(self, request: AgentRequest) -> InputRoute:
        has_uploads = bool(request.upload_context)
        has_prompt = bool(request.prompt.strip())
        if has_uploads and has_prompt:
            return InputRoute.ATTACHMENT_PLUS_TEXT
        if has_uploads:
            return InputRoute.ATTACHMENT_ONLY
        return InputRoute.TEXT_ONLY


class ReasoningEngine:
    """Decide which tools should run before producing the final reply."""

    async def build_plan(self, request: AgentRequest, route: InputRoute) -> list[PlanStep]:
        steps: list[PlanStep] = []
        if route != InputRoute.TEXT_ONLY:
            steps.append(
                PlanStep(
                    tool="document_insights",
                    objective="Review extracted document summaries to ground the response.",
                )
            )
        steps.append(PlanStep(tool="language_model", objective="Produce the final assistant reply."))
        return steps


class ToolSelector:
    """Filter out tools that are not available in this environment."""

    def __init__(self) -> None:
        self.available = {"document_insights"}

    def select(self, plan: list[PlanStep]) -> list[PlanStep]:
        return [step for step in plan if step.tool in self.available]


class ToolExecutor:
    """Execute each plan step and aggregate their outputs."""

    def execute(self, steps: list[PlanStep], request: AgentRequest) -> list[ToolResult]:
        results: list[ToolResult] = []
        for step in steps:
            if step.tool == "document_insights":
                summary = request.upload_context.strip() if request.upload_context else ""
                if summary:
                    results.append(
                        ToolResult(
                            name="document_insights",
                            output=summary,
                        )
                    )
        return results

    def render_notes(self, results: list[ToolResult]) -> str | None:
        if not results:
            return None
        rendered: list[str] = []
        for result in results:
            rendered.append(f"[{result.name}] {result.output}")
        return "\n\n".join(rendered)

    def compose_prompt(self, original_prompt: str, notes: str | None) -> str:
        if not notes:
            return original_prompt
        return (
            "Use the following tool outputs to answer the user's latest request. "
            "Cite relevant facts from these notes directly.\n\n"
            f"{notes}\n\n"
            f"User request: {original_prompt.strip()}"
        )


class AgentPipeline:
    """Wire all orchestration stages together."""

    def __init__(self) -> None:
        self.router = InputRouter()
        self.reasoner = ReasoningEngine()
        self.selector = ToolSelector()
        self.tools = ToolExecutor()

    async def run(self, request: AgentRequest) -> AgentResponse:
        route = self.router.route(request)
        plan = await self.reasoner.build_plan(request, route)
        tool_steps = self.selector.select(plan)
        tool_results = self.tools.execute(tool_steps, request)
        notes = self.tools.render_notes(tool_results)
        prompt = self.tools.compose_prompt(request.prompt, notes)
        return AgentResponse(prompt=prompt, route=route, tool_notes=notes)
