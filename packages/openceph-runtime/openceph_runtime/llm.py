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
        session_log_dir: Optional[str] = None,
    ):
        self.gateway_url = gateway_url or os.environ.get("OPENCEPH_LLM_GATEWAY_URL", "http://127.0.0.1:18792")
        # Normalize: strip trailing /v1 so we can always append /v1/chat/completions
        self.gateway_url = self.gateway_url.rstrip("/")
        if self.gateway_url.endswith("/v1"):
            self.gateway_url = self.gateway_url[:-3]
        self.gateway_token = gateway_token or os.environ.get("OPENCEPH_LLM_GATEWAY_TOKEN", "")
        self.tentacle_id = tentacle_id or os.environ.get("OPENCEPH_TENTACLE_ID", "unknown")
        self.model = os.environ.get("OPENCEPH_LLM_MODEL", "default")
        self.timeout = timeout
        # Session logging directory
        self._session_log_dir = session_log_dir or os.environ.get("OPENCEPH_TENTACLE_DIR", "")
        self._session_dir: Optional[str] = None
        if self._session_log_dir:
            import pathlib
            self._session_dir = str(pathlib.Path(self._session_log_dir) / "sessions")
            pathlib.Path(self._session_dir).mkdir(parents=True, exist_ok=True)
        self._current_session_file: Optional[str] = None
        self._last_msg_id: Optional[str] = None

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
        resolved_model = self.model if model == "default" else model
        body: dict[str, Any] = {
            "messages": messages,
            "model": resolved_model,
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
        response = LlmResponse(resp.json())

        # Session logging (llm-log-example.md format)
        self._log_session(messages, resolved_model, response)

        return response

    def start_session(self, session_id: Optional[str] = None) -> str:
        """Start a new session log file. Returns session_id."""
        import uuid, datetime
        sid = session_id or str(uuid.uuid4())
        if self._session_dir:
            self._current_session_file = os.path.join(self._session_dir, f"{sid}.jsonl")
            self._last_msg_id = None
            self._append_log({"type": "session", "version": 3, "id": sid,
                              "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()})
            self._append_log({"type": "model_change", "id": self._make_id(),
                              "parentId": None, "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                              "provider": os.environ.get("OPENCEPH_LLM_PROVIDER", "unknown"),
                              "modelId": self.model})
        return sid

    def _log_session(self, messages: list, model: str, response: "LlmResponse"):
        """Log a chat() call in llm-log-example.md format."""
        if not self._session_dir:
            return
        try:
            import datetime, uuid
            # Auto-start session if not started
            if not self._current_session_file:
                self.start_session()

            ts = datetime.datetime.now(datetime.timezone.utc).isoformat()

            # Log system prompt (only on first call or if changed)
            sys_msg = next((m for m in messages if m.get("role") == "system"), None)
            if sys_msg:
                sp_id = self._make_id()
                self._append_log({"type": "system_prompt", "id": sp_id, "parentId": self._last_msg_id,
                                  "timestamp": ts, "content": sys_msg.get("content", "")})
                self._last_msg_id = sp_id

            # Log each user message
            for m in messages:
                if m.get("role") == "user":
                    msg_id = self._make_id()
                    self._append_log({"type": "message", "id": msg_id, "parentId": self._last_msg_id,
                                      "timestamp": ts, "message": {"role": "user",
                                      "content": [{"type": "text", "text": m.get("content", "")}]}})
                    self._last_msg_id = msg_id

            # Log assistant response
            ast_id = self._make_id()
            content = []
            if response.content:
                content.append({"type": "text", "text": response.content})
            if response.tool_calls:
                for tc in response.tool_calls:
                    content.append({"type": "toolCall", "id": tc.id, "name": tc.name,
                                    "arguments": tc.arguments})
            self._append_log({"type": "message", "id": ast_id, "parentId": self._last_msg_id,
                              "timestamp": ts, "message": {"role": "assistant", "content": content,
                              "model": model, "usage": response.usage,
                              "stopReason": response.finish_reason}})
            self._last_msg_id = ast_id
        except Exception:
            pass

    def _append_log(self, record: dict):
        if self._current_session_file:
            try:
                with open(self._current_session_file, "a", encoding="utf-8") as f:
                    f.write(_json.dumps(record, ensure_ascii=False) + "\n")
            except Exception:
                pass

    @staticmethod
    def _make_id() -> str:
        import uuid
        return uuid.uuid4().hex[:8]

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
