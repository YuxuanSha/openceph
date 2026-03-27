"""
LLM 请求结构化日志 — OpenCeph 触手标准组件
所有需要调用 LLM 的 builtin skill_tentacle 直接复用此文件（由 openceph init/upgrade 自动注入）。

日志写入 <tentacle_dir>/logs/llm_sessions/<session_id>.jsonl
每个 session 一个文件，记录完整的 messages（不截断）和 assistant 回复。
"""

import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


class LlmLogger:
    """Write structured LLM request/response logs to session-based JSONL files.

    Each session gets its own JSONL file under logs/llm_sessions/.
    A session groups related LLM calls (e.g. one fetch cycle of a tentacle).
    """

    def __init__(self, log_dir: str = "", session_id: str = ""):
        if not log_dir:
            tentacle_dir = os.environ.get("OPENCEPH_TENTACLE_DIR", ".")
            log_dir = os.path.join(tentacle_dir, "logs")
        self._sessions_dir = os.path.join(log_dir, "llm_sessions")
        os.makedirs(self._sessions_dir, exist_ok=True)
        self._session_id = session_id or ""
        self._session_path: str | None = None

    def begin_session(self, session_id: str = "", metadata: dict | None = None) -> str:
        """Start a new logging session. Returns the session_id."""
        self._session_id = session_id or str(uuid.uuid4())
        self._session_path = os.path.join(
            self._sessions_dir, f"{self._session_id}.jsonl"
        )
        header = {
            "type": "session_start",
            "session_id": self._session_id,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        if metadata:
            header["metadata"] = metadata
        self._append(header)
        return self._session_id

    def end_session(self, summary: dict | None = None) -> None:
        """Mark the current session as ended."""
        if not self._session_path:
            return
        entry = {
            "type": "session_end",
            "session_id": self._session_id,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        if summary:
            entry["summary"] = summary
        self._append(entry)
        self._session_id = ""
        self._session_path = None

    def log_request(
        self,
        *,
        model: str,
        provider: str = "",
        base_url: str = "",
        messages: list | None = None,
        temperature: float = 0.0,
        max_tokens: int = 0,
        response_text: str = "",
        response_message: dict | None = None,
        usage: dict | None = None,
        duration_ms: int = 0,
        success: bool = True,
        error: str = "",
        extra: dict | None = None,
    ):
        """Log a single LLM request/response pair with full message content."""
        # Auto-create session if none exists
        if not self._session_path:
            self.begin_session()

        entry: dict = {
            "type": "llm_call",
            "ts": datetime.now(timezone.utc).isoformat(),
            "session_id": self._session_id,
            "model": model,
            "provider": provider or _infer_provider(model),
            "base_url": base_url,
            "request": {
                "messages": _full_messages(messages or []),
                "temperature": temperature,
                "max_tokens": max_tokens,
            },
            "response": {
                "role": "assistant",
                "content": response_text,
            },
            "usage": usage or {},
            "duration_ms": duration_ms,
            "success": success,
        }
        if response_message:
            entry["response"] = response_message
        if error:
            entry["error"] = error
        if extra:
            entry["extra"] = extra
        self._append(entry)

    def _append(self, entry: dict) -> None:
        if not self._session_path:
            return
        try:
            with open(self._session_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
                f.flush()
        except Exception as exc:
            sys.stderr.write(f"[llm_logger] Failed to write log: {exc}\n")

    @property
    def session_id(self) -> str:
        return self._session_id

    @property
    def sessions_dir(self) -> str:
        return self._sessions_dir


def _infer_provider(model: str) -> str:
    if "/" in model:
        return model.split("/")[0]
    return "unknown"


def _full_messages(messages: list) -> list:
    """Return full message objects with complete content (no truncation)."""
    result = []
    for msg in messages:
        entry: dict = {"role": msg.get("role", "?")}
        content = msg.get("content", "")
        if isinstance(content, str):
            entry["content"] = content
        elif isinstance(content, list):
            # Multi-part content (e.g. images + text)
            entry["content"] = content
        else:
            entry["content"] = str(content)
        # Preserve any other fields (name, tool_call_id, etc.)
        for key in msg:
            if key not in ("role", "content"):
                entry[key] = msg[key]
        result.append(entry)
    return result


def resolve_llm_config() -> tuple:
    """Resolve LLM config from OpenCeph standard env vars with provider-specific fallback.
    Returns (api_key, base_url, model).
    """
    api_key = (
        os.environ.get("OPENCEPH_LLM_API_KEY")
        or os.environ.get("OPENROUTER_API_KEY")
        or ""
    )
    base_url = (
        os.environ.get("OPENCEPH_LLM_BASE_URL")
        or os.environ.get("OPENROUTER_BASE_URL")
        or "https://openrouter.ai/api/v1"
    )
    model = (
        os.environ.get("OPENCEPH_LLM_MODEL")
        or os.environ.get("OPENROUTER_MODEL")
        or "openai/gpt-4o-mini"
    )
    return api_key, base_url, model
