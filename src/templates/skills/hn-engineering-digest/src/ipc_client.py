"""
IPC 客户端 — OpenCeph IPC 三条契约实现
所有 Python skill_tentacle 直接复用此文件
"""

import json
import socket
import uuid
import os
import threading
import logging
from datetime import datetime, timezone
from typing import Callable, Optional

log = logging.getLogger(__name__)


class IpcClient:
    def __init__(self, socket_path: str, tentacle_id: str):
        self.socket_path = socket_path
        self.tentacle_id = tentacle_id
        self._sock: Optional[socket.socket] = None
        self._directive_handler: Optional[Callable] = None
        self._recv_thread: Optional[threading.Thread] = None
        self._buffer = ""

    def connect(self):
        self._sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self._sock.connect(self.socket_path)
        self._recv_thread = threading.Thread(target=self._recv_loop, daemon=True)
        self._recv_thread.start()
        log.info(f"IPC 已连接：{self.socket_path}")

    def _send(self, msg: dict):
        line = json.dumps(msg, ensure_ascii=False) + "\n"
        self._sock.sendall(line.encode("utf-8"))

    def _recv_loop(self):
        while True:
            try:
                data = self._sock.recv(4096)
                if not data:
                    break
                self._buffer += data.decode("utf-8")
                while "\n" in self._buffer:
                    line, self._buffer = self._buffer.split("\n", 1)
                    if line.strip():
                        msg = json.loads(line)
                        self._handle_incoming(msg)
            except Exception as e:
                log.error(f"IPC 接收异常：{e}")
                break

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
    def consultation_request(self, mode: str, items: list, summary: str):
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
            },
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message_id": str(uuid.uuid4()),
        })

    # ── 契约 3：接收指令 ──
    def on_directive(self, handler: Callable):
        self._directive_handler = handler

    def close(self):
        if self._sock:
            self._sock.close()
