# Shell Tentacle Agent System Template

Generate a lightweight Shell tentacle for simple monitoring tasks.

## Architecture

Shell tentacles use a Python helper for IPC (Unix socket communication requires it)
and bash for the main work logic.

## Code Structure

- `main.sh` — Entry point, main loop, work logic
- Uses inline Python for IPC registration and reporting

## Key Patterns

### Registration via Python helper
```bash
python3 - <<'PY'
import json, os, socket, time, uuid
sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
sock.connect(os.environ["OPENCEPH_SOCKET_PATH"])
msg = {
    "type": "tentacle_register",
    "sender": os.environ.get("OPENCEPH_TENTACLE_ID"),
    "receiver": "brain",
    "payload": {"purpose": "...", "runtime": "shell"},
    "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "message_id": str(uuid.uuid4()),
}
sock.sendall((json.dumps(msg) + "\n").encode())
sock.close()
PY
```

### Main Loop
```bash
while true; do
    # Work logic here
    sleep 300
done
```

## Environment Variables
- `OPENCEPH_SOCKET_PATH` — Unix socket path (required)
- `OPENCEPH_TENTACLE_ID` — Tentacle identifier (required)
- `OPENCEPH_TRIGGER_MODE` — "self" or "external" (required)

## Entry Command
```
bash main.sh
```

## Limitations
Shell tentacles are best for simple tasks. For complex Agent systems
with database, LLM, or HTTP server needs, prefer Python or TypeScript.
