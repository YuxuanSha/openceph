"""
LlmClient — calls LLM through OpenCeph LLM Gateway (OpenAI-compatible API).
"""

import os
from typing import Optional, Any

import json as _json

import requests


class ToolCall:
    """Parsed tool_call with .id, .name, .arguments attributes."""

    def __init__(self, data: dict):
        self._data = data
        self.id: str = data.get("id", "")
        func = data.get("function", {})
        self.name: str = func.get("name", "")
        args = func.get("arguments", "{}")
        self.arguments: dict = _json.loads(args) if isinstance(args, str) else args

    def __repr__(self) -> str:
        return f"ToolCall(id={self.id!r}, name={self.name!r})"


class LlmResponse:
    """Parsed response from LLM Gateway."""

    def __init__(self, data: dict):
        self._data = data
        choice = data.get("choices", [{}])[0]
        message = choice.get("message", {})

        self.content: Optional[str] = message.get("content")
        self.role: str = message.get("role", "assistant")
        self.finish_reason: str = choice.get("finish_reason", "")

        # tool_calls: wrap raw dicts into ToolCall objects (contract: tc.id / tc.name / tc.arguments)
        raw_tool_calls = message.get("tool_calls")
        self.tool_calls: Optional[list[ToolCall]] = (
            [ToolCall(tc) for tc in raw_tool_calls] if raw_tool_calls else None
        )

        # usage: exposed as dict (contract) + individual int attrs (convenience)
        raw_usage = data.get("usage", {})
        self.usage: dict = {
            "prompt_tokens": raw_usage.get("prompt_tokens", 0),
            "completion_tokens": raw_usage.get("completion_tokens", 0),
        }
        self.input_tokens: int = self.usage["prompt_tokens"]
        self.output_tokens: int = self.usage["completion_tokens"]
        self.total_tokens: int = raw_usage.get("total_tokens", 0)

    @property
    def raw(self) -> dict:
        return self._data


class LlmClient:
    """
    LLM client that calls OpenCeph LLM Gateway.

    Auto-reads OPENCEPH_LLM_GATEWAY_URL and OPENCEPH_LLM_GATEWAY_TOKEN
    from environment variables. All requests go through the local gateway.
    """

    def __init__(
        self,
        gateway_url: Optional[str] = None,
        gateway_token: Optional[str] = None,
        tentacle_id: Optional[str] = None,
        timeout: int = 120,
    ):
        self.gateway_url = gateway_url or os.environ.get("OPENCEPH_LLM_GATEWAY_URL", "http://127.0.0.1:18792")
        self.gateway_token = gateway_token or os.environ.get("OPENCEPH_LLM_GATEWAY_TOKEN", "")
        self.tentacle_id = tentacle_id or os.environ.get("OPENCEPH_TENTACLE_ID", "unknown")
        self.timeout = timeout

    def chat(
        self,
        messages: list[dict[str, str]],
        model: str = "default",
        tools: Optional[list[dict]] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        stream: bool = False,
    ) -> LlmResponse:
        """
        Send a chat completion request to LLM Gateway.

        Args:
            messages: List of message dicts (role + content).
            model: "default", "fallback", or specific model ID.
            tools: Optional list of tool definitions (OpenAI function calling format).
            temperature: Sampling temperature.
            max_tokens: Max response tokens.
            stream: Whether to stream (not yet supported in this client).

        Returns:
            LlmResponse with parsed content, tool_calls, and usage.
        """
        body: dict[str, Any] = {
            "messages": messages,
            "model": model,
        }
        if tools:
            body["tools"] = tools
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if stream:
            body["stream"] = True

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.gateway_token}",
            "X-Tentacle-Id": self.tentacle_id,
        }

        resp = requests.post(
            f"{self.gateway_url}/v1/chat/completions",
            headers=headers,
            json=body,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return LlmResponse(resp.json())

    def health(self) -> dict:
        """Check LLM Gateway health."""
        resp = requests.get(f"{self.gateway_url}/health", timeout=5)
        resp.raise_for_status()
        return resp.json()


def call_llm(
    messages: list[dict[str, str]],
    tools: Optional[list[dict]] = None,
    temperature: float = 0.3,
    model: str = "default",
) -> LlmResponse:
    """Convenience function: one-shot LLM call via gateway."""
    client = LlmClient()
    return client.chat(messages, model=model, tools=tools, temperature=temperature)
