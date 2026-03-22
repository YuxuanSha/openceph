import json
import os
import socket
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
    def __init__(self, socket_path: str, tentacle_id: str):
        self.socket_path = socket_path
        self.tentacle_id = tentacle_id
        self.sock = None
        self.directive_handler = None
        self.buffer = ""

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.socket_path)
        threading.Thread(target=self._recv_loop, daemon=True).start()

    def on_directive(self, handler):
        self.directive_handler = handler

    def register(self, purpose: str, runtime: str):
        self._send("tentacle_register", {"tentacle_id": self.tentacle_id, "purpose": purpose, "runtime": runtime})

    def consultation_request(self, mode: str, items: list, summary: str, context: str = ""):
        payload = {
            "tentacle_id": self.tentacle_id,
            "request_id": str(uuid.uuid4()),
            "mode": mode,
            "items": items,
            "summary": summary,
            "context": context,
        }
        self._send("consultation_request", payload)

    def _send(self, msg_type: str, payload: dict):
        message = {
            "type": msg_type,
            "sender": self.tentacle_id,
            "receiver": "brain",
            "payload": payload,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message_id": str(uuid.uuid4()),
        }
        self.sock.sendall((json.dumps(message, ensure_ascii=False) + "\n").encode("utf-8"))

    def _recv_loop(self):
        while True:
            data = self.sock.recv(4096)
            if not data:
                return
            self.buffer += data.decode("utf-8")
            while "\n" in self.buffer:
                line, self.buffer = self.buffer.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                payload = json.loads(line)
                if payload.get("type") == "directive" and self.directive_handler:
                    self.directive_handler(payload.get("payload") or {})
