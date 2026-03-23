"""
IPC 客户端 — OpenCeph stdin/stdout JSON Lines 协议
所有 Python skill_tentacle 直接复用此文件。
"""

import json
import logging
import os
import sys
import threading
import uuid
from datetime import datetime, timezone
from typing import Callable, Optional

log = logging.getLogger(__name__)


class IpcClient:
    def __init__(self, tentacle_id: str):
        self.tentacle_id = tentacle_id
        self._directive_handler: Optional[Callable] = None
        self._recv_thread: Optional[threading.Thread] = None

    def connect(self):
        self._recv_thread = threading.Thread(target=self._recv_loop, daemon=True)
        self._recv_thread.start()
        log.info("IPC 已就绪（stdin/stdout）")

    def _send(self, msg: dict):
        line = json.dumps(msg, ensure_ascii=False) + "\n"
        sys.stdout.write(line)
        sys.stdout.flush()

    def _recv_loop(self):
        for raw_line in sys.stdin:
            try:
                line = raw_line.strip()
                if not line:
                    continue
                msg = json.loads(line)
                self._handle_incoming(msg)
            except Exception as exc:
                log.error(f"IPC 接收异常：{exc}")

    def _handle_incoming(self, msg: dict):
        msg_type = msg.get("type")
        if msg_type == "directive" and self._directive_handler:
            self._directive_handler(msg.get("payload", {}))
        elif msg_type == "consultation_reply":
            log.info(f"协商回复：{msg.get('payload', {}).get('decision')}")

    # ── 契约 1：启动注册 ──
    def register(self, purpose: str, runtime: str):
        self._send({
            "type": "tentacle_register",
            "sender": self.tentacle_id,
            "receiver": "brain",
            "payload": {
                "tentacle_id": self.tentacle_id,
                "purpose": purpose,
                "runtime": runtime,
                "pid": os.getpid(),
            },
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message_id": str(uuid.uuid4()),
        })

    # ── 契约 2：批量上报 ──
    def consultation_request(self, mode: str, items: list, summary: str, context: str = ""):
        self._send({
            "type": "consultation_request",
            "sender": self.tentacle_id,
            "receiver": "brain",
            "payload": {
                "tentacle_id": self.tentacle_id,
                "request_id": str(uuid.uuid4()),
                "mode": mode,
                "items": items,
                "summary": summary,
                "context": context,
            },
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message_id": str(uuid.uuid4()),
        })

    # ── 契约 3：接收指令 ──
    def on_directive(self, handler: Callable):
        self._directive_handler = handler

    def close(self):
        pass
