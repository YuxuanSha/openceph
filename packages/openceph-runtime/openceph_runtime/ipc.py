"""
IpcClient — communicates with Brain via stdin/stdout JSON-line protocol.

Message envelope format (per spec §2):
{
  "type": "<message_type>",
  "tentacle_id": "t_xxx",
  "message_id": "<UUID v4>",
  "timestamp": "2026-03-26T16:00:00Z",
  "payload": { ... }
}
"""

import json
import os
import sys
import threading
import uuid
from datetime import datetime, timezone
from typing import Callable, Optional, Any


def _make_message(msg_type: str, tentacle_id: str, payload: dict) -> dict:
    """Create an IPC message envelope per spec §2."""
    return {
        "type": msg_type,
        "tentacle_id": tentacle_id,
        "message_id": str(uuid.uuid4()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "payload": payload,
    }


class IpcClient:
    """
    IPC client for tentacle <-> Brain communication via stdin/stdout.

    All messages use JSON-line format (one JSON object per line).
    Brain writes to tentacle's stdin; tentacle writes to stdout.
    """

    def __init__(self):
        self._tentacle_id: str = os.environ.get("OPENCEPH_TENTACLE_ID", "unknown")
        self._handlers: dict[str, list[Callable]] = {}
        self._reader_thread: Optional[threading.Thread] = None
        self._running = False
        self._lock = threading.Lock()
        # Pending tool_request results keyed by tool_call_id
        self._pending_tool_results: dict[str, threading.Event] = {}
        self._tool_results: dict[str, dict] = {}

    def connect(self) -> None:
        """Start the IPC reader thread to receive messages from Brain."""
        if self._running:
            return
        self._running = True
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()

    def close(self) -> None:
        """Stop the IPC reader."""
        self._running = False

    # ─── Tentacle -> Brain messages ──────────────────────

    def register(
        self,
        purpose: str = "",
        runtime: str = "python",
        capabilities: Optional[dict] = None,
        tools: Optional[list[str]] = None,
        version: Optional[str] = None,
    ) -> None:
        """Send tentacle_register message to Brain.

        Per protocol: capabilities is a three-layer object with daemon/agent/consultation keys.
        """
        payload: dict[str, Any] = {
            "purpose": purpose,
            "runtime": runtime,
            "pid": os.getpid(),
            "capabilities": capabilities or {"daemon": [], "agent": [], "consultation": {"mode": "batch"}},
        }
        if tools is not None:
            payload["tools"] = tools
        if version is not None:
            payload["version"] = version
        self._send(_make_message("tentacle_register", self._tentacle_id, payload))

    def status_update(
        self,
        status: str = "idle",
        pending_items: int = 0,
        health: str = "ok",
        next_scheduled_run: Optional[str] = None,
        stats: Optional[dict] = None,
    ) -> None:
        """Send status_update to Brain. Per spec §3.5: last_daemon_run and pending_items are required."""
        payload: dict[str, Any] = {
            "status": status,
            "pending_items": pending_items,
            "health": health,
            "last_daemon_run": datetime.now(timezone.utc).isoformat(),
        }
        if next_scheduled_run:
            payload["next_scheduled_run"] = next_scheduled_run
        if stats:
            payload["stats"] = stats
        self._send(_make_message("status_update", self._tentacle_id, payload))

    def consultation_request(
        self,
        mode: str = "batch",
        summary: str = "",
        initial_message: str = "",
        item_count: int = 0,
        urgency: str = "normal",
        context: Optional[dict] = None,
    ) -> str:
        """
        Send consultation_request to Brain.
        Per spec §3.2: mode, summary, item_count, initial_message are required.
        Brain assigns the consultation_id and returns it in consultation_reply.
        Returns: request_id (client-generated) for tracking this consultation.
        """
        request_id = str(uuid.uuid4())
        payload: dict[str, Any] = {
            "request_id": request_id,
            "mode": mode,
            "summary": summary,
            "initial_message": initial_message,
            "item_count": item_count,
            "urgency": urgency,
            "context": context or {},
        }
        self._send(_make_message("consultation_request", self._tentacle_id, payload))
        return request_id

    def consultation_message(self, consultation_id: str, message: str) -> None:
        """Send a follow-up message within an active consultation."""
        self._send(_make_message("consultation_message", self._tentacle_id, {
            "consultation_id": consultation_id,
            "message": message,
        }))

    def consultation_end(self, consultation_id: str, reason: str = "complete") -> None:
        """Tentacle-side end of a consultation session."""
        self._send(_make_message("consultation_end", self._tentacle_id, {
            "consultation_id": consultation_id,
            "reason": reason,
        }))

    def heartbeat_ack(self) -> None:
        """Respond to a heartbeat_ping from Brain. Per spec §3.6: empty payload."""
        self._send(_make_message("heartbeat_ack", self._tentacle_id, {}))

    def tool_request(
        self,
        tool_name: str,
        tool_call_id: str,
        arguments: dict,
        timeout: float = 30.0,
    ) -> dict:
        """Request Brain to execute a shared tool (openceph_* prefixed). Per spec §3.7.

        Blocks until Brain returns a tool_result or timeout is reached.
        Returns: {"result": {...}, "success": bool, "error": str|None}
        """
        event = threading.Event()
        self._pending_tool_results[tool_call_id] = event

        self._send(_make_message("tool_request", self._tentacle_id, {
            "tool_name": tool_name,
            "tool_call_id": tool_call_id,
            "arguments": arguments,
        }))

        # Block until tool_result arrives or timeout
        if not event.wait(timeout=timeout):
            self._pending_tool_results.pop(tool_call_id, None)
            return {"result": {}, "success": False, "error": f"tool_request timed out after {timeout}s"}

        result = self._tool_results.pop(tool_call_id, {"result": {}, "success": False, "error": "no result"})
        self._pending_tool_results.pop(tool_call_id, None)
        return result

    # ─── Event handler decorators ────────────────────────

    def on_directive(self, handler: Callable) -> Callable:
        """Decorator: register handler for Brain directives (pause/resume/kill/run_now/config_update/flush_pending)."""
        self._register_handler("directive", handler)
        return handler

    def on_consultation_reply(self, handler: Callable) -> Callable:
        """Decorator: register handler for Brain consultation replies.

        Handler signature: (consultation_id, message, actions_taken, should_continue, client_request_id) -> None
        """
        self._register_handler("consultation_reply", handler)
        return handler

    def on_consultation_close(self, handler: Callable) -> Callable:
        """Decorator: register handler for Brain consultation close.

        Handler signature: (consultation_id, summary, pushed_count, discarded_count, feedback, client_request_id) -> None
        """
        self._register_handler("consultation_close", handler)
        return handler

    def on_heartbeat_ping(self, handler: Callable) -> Callable:
        """Decorator: register handler for heartbeat pings (auto-ack by default)."""
        self._register_handler("heartbeat_ping", handler)
        return handler

    def on_tool_result(self, handler: Callable) -> Callable:
        """Decorator: register handler for shared tool results from Brain.

        Handler signature: (tool_call_id, result, success, error) -> None
        Called when Brain returns a tool_result for a prior tool_request.
        """
        self._register_handler("tool_result", handler)
        return handler

    # ─── Internal ────────────────────────────────────────

    def _register_handler(self, event_type: str, handler: Callable) -> None:
        if event_type not in self._handlers:
            self._handlers[event_type] = []
        self._handlers[event_type].append(handler)

    def _send(self, message: dict) -> None:
        """Write a JSON message to stdout (-> Brain)."""
        with self._lock:
            line = json.dumps(message, ensure_ascii=False)
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def _read_loop(self) -> None:
        """Read JSON messages from stdin (<- Brain)."""
        while self._running:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue

                message = json.loads(line)
                msg_type = message.get("type", "")
                payload = message.get("payload", {})

                if msg_type == "directive":
                    for h in self._handlers.get("directive", []):
                        try:
                            h(payload.get("action", ""), payload.get("params", {}))
                        except Exception:
                            pass

                elif msg_type == "consultation_reply":
                    for h in self._handlers.get("consultation_reply", []):
                        try:
                            h(
                                payload.get("consultation_id", ""),
                                payload.get("message", ""),
                                payload.get("actions_taken", []),
                                payload.get("continue", False),
                                payload.get("client_request_id", ""),
                            )
                        except Exception:
                            pass

                elif msg_type == "consultation_close":
                    for h in self._handlers.get("consultation_close", []):
                        try:
                            h(
                                payload.get("consultation_id", ""),
                                payload.get("summary", ""),
                                payload.get("pushed_count", 0),
                                payload.get("discarded_count", 0),
                                payload.get("feedback"),
                                payload.get("client_request_id", ""),
                            )
                        except Exception:
                            pass

                elif msg_type == "heartbeat_ping":
                    # Per spec §4.4: always auto-ack (empty payload both ways)
                    self.heartbeat_ack()
                    for h in self._handlers.get("heartbeat_ping", []):
                        try:
                            h()
                        except Exception:
                            pass

                elif msg_type == "tool_result":
                    # Per spec §4.5: tool_call_id, result (object), success (bool), error
                    tcid = payload.get("tool_call_id", "")
                    # Unblock any synchronous tool_request() waiter
                    if tcid in self._pending_tool_results:
                        self._tool_results[tcid] = {
                            "result": payload.get("result", {}),
                            "success": payload.get("success", False),
                            "error": payload.get("error"),
                        }
                        self._pending_tool_results[tcid].set()
                    for h in self._handlers.get("tool_result", []):
                        try:
                            h(
                                tcid,
                                payload.get("result", {}),
                                payload.get("success", False),
                                payload.get("error"),
                            )
                        except Exception:
                            pass

            except json.JSONDecodeError:
                continue
            except Exception:
                if not self._running:
                    break
                continue
