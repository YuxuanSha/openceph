"""
TentacleConfig — auto-loads configuration from environment variables and .env files.
Also reads tentacle.json for structured metadata (purpose, poll_interval, batch_threshold, capabilities).
"""

import json
import os
from pathlib import Path
from typing import Any, Optional


def _env_int(key: str, default: int) -> int:
    """Read an env var as int, falling back to default on empty string or parse error."""
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def _env_str(key: str, default: str = "") -> str:
    """Read an env var as str, falling back to default on empty string."""
    raw = os.environ.get(key, "").strip()
    return raw if raw else default


def _load_dotenv(env_path: Path) -> None:
    """Load a .env file into os.environ without overwriting existing vars."""
    if not env_path.is_file():
        return
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            eq_idx = stripped.find("=")
            if eq_idx < 1:
                continue
            key = stripped[:eq_idx].strip()
            value = stripped[eq_idx + 1:].strip()
            # Strip surrounding quotes
            if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
                value = value[1:-1]
            # Don't overwrite env vars already set by parent process
            if key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


class TentacleConfig:
    """Tentacle configuration, auto-populated from OPENCEPH_* environment variables."""

    def __init__(self):
        # Auto-load .env from tentacle dir (if set) before reading env vars
        tentacle_dir = os.environ.get("OPENCEPH_TENTACLE_DIR", ".")
        _load_dotenv(Path(tentacle_dir) / ".env")

        self.tentacle_id: str = _env_str("OPENCEPH_TENTACLE_ID", "unknown")
        self.tentacle_dir: Path = Path(_env_str("OPENCEPH_TENTACLE_DIR", "."))
        self.workspace: Path = Path(_env_str("OPENCEPH_TENTACLE_WORKSPACE", "./workspace"))
        self.runtime_dir: Path = Path(_env_str("OPENCEPH_RUNTIME_DIR", "."))
        self.socket_path: str = _env_str("OPENCEPH_SOCKET_PATH", "")

        self.llm_gateway_url: str = _env_str("OPENCEPH_LLM_GATEWAY_URL", "http://127.0.0.1:18792")
        self.llm_gateway_token: str = _env_str("OPENCEPH_LLM_GATEWAY_TOKEN", "")

        self.trigger_mode: str = _env_str("OPENCEPH_TRIGGER_MODE", "self")
        self.self_schedule: str = _env_str("OPENCEPH_SELF_SCHEDULE", "")
        self.self_interval_seconds: int = _env_int("OPENCEPH_SELF_INTERVAL_SECONDS", 3600)

        # Load tentacle.json for structured metadata
        self._tentacle_json: dict[str, Any] = {}
        tentacle_json_path = self.tentacle_dir / "tentacle.json"
        if tentacle_json_path.is_file():
            try:
                self._tentacle_json = json.loads(tentacle_json_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                pass

        # Derived — env vars take precedence, then tentacle.json, then defaults
        self.purpose: str = (
            _env_str("OPENCEPH_PURPOSE")
            or self._tentacle_json.get("purpose", "")
        )
        poll_default = self._tentacle_json.get("pollInterval", self.self_interval_seconds)
        self.poll_interval: int = _env_int("OPENCEPH_POLL_INTERVAL", int(poll_default) if poll_default else self.self_interval_seconds)
        batch_default = self._tentacle_json.get("capabilities", {}).get("consultation", {}).get("batchThreshold", 5)
        self.batch_threshold: int = _env_int("OPENCEPH_BATCH_THRESHOLD", int(batch_default) if batch_default else 5)

        # Capabilities from tentacle.json (three-layer object per protocol)
        self.capabilities: dict[str, Any] = self._tentacle_json.get("capabilities", {})

    def get(self, key: str, default: Any = None) -> Any:
        """Get a config value by dot-separated key path.

        Looks up in order: env var OPENCEPH_{KEY}, tentacle.json nested path, default.
        Example: config.get("capabilities.consultation.mode")
        """
        # Try env var first (dot → underscore, uppercased)
        env_key = "OPENCEPH_" + key.upper().replace(".", "_")
        env_val = os.environ.get(env_key)
        if env_val is not None:
            return env_val

        # Walk the tentacle.json dict by dot path
        parts = key.split(".")
        current: Any = self._tentacle_json
        for part in parts:
            if isinstance(current, dict):
                current = current.get(part)
            else:
                return default
            if current is None:
                return default
        return current

    def ensure_workspace(self) -> Path:
        """Ensure workspace directory exists and return its path."""
        self.workspace.mkdir(parents=True, exist_ok=True)
        return self.workspace

    def ensure_data_dir(self) -> Path:
        """Ensure data directory exists under tentacle dir."""
        data_dir = self.tentacle_dir / "data"
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir
