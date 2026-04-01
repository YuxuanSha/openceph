"""
IPC Client — OpenCeph stdin/stdout JSON Lines Protocol
All builtin skill_tentacles reuse this file directly (auto-injected by openceph init/upgrade).

Protocol (per spec §2):
  - Tentacle → Brain: write JSON Lines to stdout
  - Brain → Tentacle: read JSON Lines from stdin
  - stderr is for logging only, never IPC
  - message_id: UUID v4
  - No sender/receiver fields — only type, tentacle_id, message_id, timestamp, payload
"""

import json
import os
import sys
import threading
import uuid
from datetime import datetime, timezone


def load_dotenv(base_dir: str) -> None:
    env_path = os.path.join(base_dir, ".env")
    if not os.path.exists(env_path):
        return
    with open(env_path, "r", encoding="utf-8") as handle:
        for raw in handle:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


class IpcClient:
    def __init__(self, tentacle_id: str):
        self.tentacle_id = tentacle_id
        self._directive_handler = None
        self._heartbeat_handler = None

    def connect(self):
        threading.Thread(target=self._recv_loop, daemon=True).start()

    def on_directive(self, handler):
        """Register handler for directive messages (pause/resume/kill/run_now/...)."""
        self._directive_handler = handler

    def on_heartbeat(self, handler):
        """Register handler for heartbeat_ping messages.
        Handler receives no arguments (spec: empty payload).
        Should return a dict with keys:
          status: "ok" | "acted"
          actions: optional list of action description strings
          adjustments: optional list of adjustment dicts
        Returning None is equivalent to returning {"status": "ok"}.
        """
        self._heartbeat_handler = handler

    # ── Contract 1: Startup Registration ──

    def register(self, purpose: str, runtime: str):
        self._send("tentacle_register", {
            "purpose": purpose,
            "runtime": runtime,
            "pid": os.getpid(),
        })

    # ── Contract 2: Consultation (per spec §3.2) ──

    def consultation_request(self, mode: str, summary: str, initial_message: str, item_count: int = 0, context: dict = None):
        """Send a consultation request to Brain. Brain assigns consultation_id in reply."""
        self._send("consultation_request", {
            "mode": mode,
            "summary": summary,
            "initial_message": initial_message,
            "item_count": item_count,
            "urgency": "normal",
            "context": context or {},
        })

    # ── Contract 4: Heartbeat Response (per spec §3.6: empty payload) ──

    def heartbeat_ack(self):
        """Send heartbeat_ack (liveness confirmation) to Brain. Spec: empty payload."""
        self._send("heartbeat_ack", {})

    # ── Contract 4: Status Reporting (per spec §3.5) ──

    def status_update(self, status: str = "idle", pending_items: int = 0, health: str = "ok", stats: dict = None):
        """Send status_update to Brain. last_daemon_run and pending_items are required per spec."""
        payload = {
            "status": status,
            "pending_items": pending_items,
            "health": health,
            "last_daemon_run": datetime.now(timezone.utc).isoformat(),
        }
        if stats:
            payload["stats"] = stats
        self._send("status_update", payload)

    # ── Internal Implementation ──

    def _send(self, msg_type: str, payload: dict):
        message = {
            "type": msg_type,
            "tentacle_id": self.tentacle_id,
            "message_id": str(uuid.uuid4()),
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        }
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def _recv_loop(self):
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg_type = msg.get("type")
            payload = msg.get("payload") or {}

            if msg_type == "directive" and self._directive_handler:
                self._directive_handler(payload)

            elif msg_type == "heartbeat_ping":
                # Per spec §4.4: always ack with empty payload
                self.heartbeat_ack()
                # If handler registered, invoke for rich analysis
                if self._heartbeat_handler:
                    result = self._heartbeat_handler()
                    if result and isinstance(result, dict):
                        self.heartbeat_result(
                            status=result.get("status", "ok"),
                            actions=result.get("actions"),
                            adjustments=result.get("adjustments"),
                        )

    def close(self):
        pass
