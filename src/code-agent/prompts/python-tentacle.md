# Python Tentacle Agent System Template

Generate a complete Python Agent system with the following structure:

## Required Architecture

1. **IPC Connection**: Connect to Unix socket via `OPENCEPH_SOCKET_PATH`
2. **Registration**: Send `tentacle_register` immediately on startup
3. **Main Loop**: Work cycle → accumulate → batch report via `consultation_request`
4. **Directive Handler**: Background thread listening for `directive` messages (pause/resume/kill)
5. **Trigger Mode**: Respect `OPENCEPH_TRIGGER_MODE` (self = internal scheduling, external = wait for triggers)

## Code Structure

- `main.py` — Entry point, IPC connection, main loop, directive handling
- `db.py` — SQLite state management (if database needed)
- `llm_client.py` — LLM API calls via OpenRouter (if LLM needed)
- `requirements.txt` — Dependencies

## Key Patterns

### IPC Communication
```python
import json, os, socket, threading, uuid, time

class IpcConnection:
    def __init__(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(os.environ["OPENCEPH_SOCKET_PATH"])

    def send(self, msg_type, payload):
        msg = json.dumps({
            "type": msg_type, "sender": TENTACLE_ID,
            "receiver": "brain", "payload": payload,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "message_id": str(uuid.uuid4()),
        }) + "\n"
        self.sock.sendall(msg.encode("utf-8"))
```

### Batch Consultation
```python
def send_consultation(self):
    self.ipc.send("consultation_request", {
        "tentacle_id": TENTACLE_ID,
        "request_id": str(uuid.uuid4()),
        "mode": "batch",
        "items": [...],
        "summary": "...",
        "context": "...",
    })
```

### Internal Decision Logic
The tentacle should have its own filtering and quality logic:
- Accumulate findings internally
- Judge each finding (important/reference/uncertain)
- Decide when to report (e.g., 3+ items, high-urgency item, daily minimum)

## Environment Variables
- `OPENCEPH_SOCKET_PATH` — Unix socket path (required)
- `OPENCEPH_TENTACLE_ID` — Tentacle identifier (required)
- `OPENCEPH_TRIGGER_MODE` — "self" or "external" (required)
- `OPENCEPH_LLM_API_KEY` / `OPENCEPH_LLM_BASE_URL` / `OPENCEPH_LLM_MODEL` — LLM runtime config (if LLM needed)

## Setup Commands
```
python3 -m venv venv
venv/bin/pip install -r requirements.txt
```

## Entry Command
```
./venv/bin/python main.py
```
