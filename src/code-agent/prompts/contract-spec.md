# OpenCeph Tentacle IPC Contract Specification

The tentacle must communicate with the OpenCeph brain over JSON Lines IPC on a Unix socket.

## Connection

Connect to the Unix domain socket at `OPENCEPH_SOCKET_PATH` environment variable.
All messages are JSON objects, one per line (newline-delimited).

## Message Format

Every message MUST have these fields:
```json
{
  "type": "message_type",
  "sender": "tentacle_id",
  "receiver": "brain",
  "payload": { ... },
  "timestamp": "ISO8601",
  "message_id": "uuid"
}
```

## Required Messages

### 1. `tentacle_register` (MUST send on startup)
```json
{
  "type": "tentacle_register",
  "payload": { "purpose": "...", "runtime": "python|typescript|go|shell" }
}
```

### 2. `consultation_request` (Primary reporting — batch session mode)
The tentacle accumulates findings internally, then sends a batch consultation:
```json
{
  "type": "consultation_request",
  "payload": {
    "tentacle_id": "t_xxx",
    "request_id": "uuid",
    "mode": "batch",
    "items": [
      {
        "id": "uuid",
        "content": "description of finding",
        "tentacleJudgment": "important|reference|uncertain",
        "reason": "why this matters",
        "sourceUrl": "optional url",
        "timestamp": "ISO8601"
      }
    ],
    "summary": "Brief summary of this batch",
    "context": "Additional context for the brain"
  }
}
```

Modes:
- `batch` — multiple accumulated findings (most common)
- `single` — one finding needing brain judgment (legacy compatibility)
- `action_confirm` — request user confirmation for an action (e.g., publish article)

For `action_confirm` mode:
```json
{
  "mode": "action_confirm",
  "action": {
    "type": "publish_article|create_issue|send_message|...",
    "description": "What action to take",
    "content": "Optional content to review"
  },
  "summary": "Need user confirmation to...",
  "context": "..."
}
```

### 3. `report_finding` (Legacy — use sparingly)
Only for urgent, high-confidence single findings:
```json
{
  "type": "report_finding",
  "payload": {
    "findingId": "uuid",
    "summary": "...",
    "confidence": 0.9,
    "details": "optional"
  }
}
```

## Required Handlers

### `directive` (MUST handle)
```json
{
  "type": "directive",
  "payload": { "action": "pause|resume|kill|run_now|shutdown" }
}
```
At minimum: `pause` (stop work), `resume` (resume work), `kill`/`shutdown` (graceful exit).

### `heartbeat_trigger` (RECOMMENDED)
```json
{
  "type": "heartbeat_trigger",
  "payload": { "tentacle_id": "...", "prompt": "..." }
}
```
Respond with:
```json
{
  "type": "heartbeat_result",
  "payload": { "tentacle_id": "...", "status": "ok|acted", "adjustments": [] }
}
```

## Trigger Mode

The tentacle MUST respect `OPENCEPH_TRIGGER_MODE` environment variable:
- `self` — tentacle manages its own scheduling (sleep loops, internal cron)
- `external` — tentacle waits for external triggers (directives, cron jobs)

## Key Principles

1. **Tentacle owns its decision logic** — the tentacle decides what to report, when, and with what judgment
2. **Batch over single** — accumulate findings and send batch consultations rather than individual reports
3. **Brain is the gateway to user** — never contact the user directly, always go through the brain
4. **Graceful shutdown** — handle SIGTERM and kill directive cleanly
