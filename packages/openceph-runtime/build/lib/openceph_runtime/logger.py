"""
TentacleLogger — structured logging for tentacles.

Writes JSON-line logs to separate files per category:
  - logs/daemon.log — engineering daemon events
  - logs/agent.log — LLM/agent events
  - logs/consultation.log — consultation session events
"""

import json
import os
import time
from pathlib import Path
from typing import Any


class TentacleLogger:
    """Structured JSON logger for tentacles."""

    def __init__(self, log_dir: str | Path | None = None):
        if log_dir:
            self._log_dir = Path(log_dir)
        else:
            tentacle_dir = os.environ.get("OPENCEPH_TENTACLE_DIR", ".")
            self._log_dir = Path(tentacle_dir) / "logs"
        self._log_dir.mkdir(parents=True, exist_ok=True)

        self._tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "unknown")

    def daemon(self, event: str, **kwargs: Any) -> None:
        """Log a daemon-layer event (engineering logic)."""
        self._write("daemon", event, kwargs)

    def agent(self, event: str, **kwargs: Any) -> None:
        """Log an agent-layer event (LLM calls, tool calls)."""
        self._write("agent", event, kwargs)

    def consultation(self, event: str, **kwargs: Any) -> None:
        """Log a consultation-layer event."""
        self._write("consultation", event, kwargs)

    def error(self, event: str, **kwargs: Any) -> None:
        """Log an error event."""
        self._write("error", event, kwargs)

    def _write(self, category: str, event: str, data: dict) -> None:
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "tentacle": self._tentacle_id,
            "category": category,
            "event": event,
            **data,
        }
        log_file = self._log_dir / f"{category}.log"
        try:
            with open(log_file, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
        except Exception:
            # Logging should never crash the tentacle
            pass
