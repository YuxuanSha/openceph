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
        self.handler = None

    def connect(self):
        threading.Thread(target=self._recv_loop, daemon=True).start()

    def on_directive(self, handler):
        self.handler = handler

    def register(self, purpose: str, runtime: str):
        self._send("tentacle_register", {"tentacle_id": self.tentacle_id, "purpose": purpose, "runtime": runtime})

    def consultation_request(self, mode: str, items: list, summary: str, context: str = ""):
        self._send("consultation_request", {
            "tentacle_id": self.tentacle_id,
            "request_id": str(uuid.uuid4()),
            "mode": mode,
            "items": items,
            "summary": summary,
            "context": context,
        })

    def _send(self, msg_type: str, payload: dict):
        message = {
            "type": msg_type,
            "sender": self.tentacle_id,
            "receiver": "brain",
            "payload": payload,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message_id": str(uuid.uuid4()),
        }
        sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    def _recv_loop(self):
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if not line:
                continue
            payload = json.loads(line)
            if payload.get("type") == "directive" and self.handler:
                self.handler(payload.get("payload") or {})

    def close(self):
        pass
