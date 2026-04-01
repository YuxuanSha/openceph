# IPC Communication Protocol Complete Reference

**File location:** `contracts/skill-tentacle-spec/reference/ipc-protocol.md`
**Purpose:** Complete IPC message format definitions between tentacles and Brain

---

## 1. Transport Layer

- **Transport method:** stdin/stdout pipe (child process stdio)
- **Message format:** JSON Lines — each message is a single valid JSON line terminated by `\n`
- **stderr:** Used for log output, not part of IPC; Brain writes stderr content to the tentacle's `logs/daemon.log`
- **Encoding:** UTF-8
- **Direction:** Full-duplex. Tentacle writes to stdout = sends message to Brain; tentacle reads from stdin = receives Brain messages

**Important:** Does not use Unix Domain Socket, TCP, or HTTP. Brain starts the tentacle via `child_process.spawn()` with stdio configured in pipe mode.

---

## 2. Message Envelope Format

All messages share a unified envelope:

```json
{
  "type": "string",
  "tentacle_id": "string",
  "message_id": "string (UUID v4)",
  "timestamp": "string (ISO 8601)",
  "payload": {}
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `type` | Yes | Message type identifier |
| `tentacle_id` | Yes | Tentacle ID |
| `message_id` | Yes | Unique message ID (UUID v4) |
| `timestamp` | Yes | UTC time in ISO 8601 format |
| `payload` | Yes | Message body, structure varies by type |

---

## 3. Tentacle → Brain Messages

### 3.1 tentacle_register

**Trigger:** Sent immediately after tentacle process starts (must be within 30 seconds)

```json
{
  "type": "tentacle_register",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-001",
  "timestamp": "2026-03-26T10:00:00Z",
  "payload": {
    "purpose": "Monitor latest arXiv papers",
    "runtime": "python",
    "pid": 12346,
    "capabilities": {
      "daemon": ["rss_fetch", "api_integration", "database"],
      "agent": ["content_analysis", "quality_judgment"],
      "consultation": {
        "mode": "batch",
        "batchThreshold": 5
      }
    },
    "tools": ["search_arxiv", "fetch_paper_details"],
    "version": "1.0.0"
  }
}
```

| Payload Field | Required | Type | Description |
|---------------|----------|------|-------------|
| `purpose` | Yes | string | Tentacle purpose (one sentence) |
| `runtime` | Yes | string | `python` / `typescript` / `go` / `shell` |
| `pid` | Yes | number | Process PID |
| `capabilities` | Yes | object | Three-layer capability declaration |
| `capabilities.daemon` | Yes | string[] | First-layer capability list |
| `capabilities.agent` | Yes | string[] | Second-layer capability list |
| `capabilities.consultation` | Yes | object | Third-layer strategy |
| `capabilities.consultation.mode` | Yes | string | `batch` / `realtime` / `periodic` |
| `capabilities.consultation.batchThreshold` | Required for batch mode | number | Accumulation threshold |
| `tools` | No | string[] | Custom tool name list |
| `version` | No | string | Tentacle version number |

**Brain response:** No explicit response. Brain marks the tentacle as `running` upon receipt. If this message is not received within 30 seconds, Brain will kill the process.

---

### 3.2 consultation_request

**Trigger:** After the tentacle Agent layer has filtered content worth reporting

```json
{
  "type": "consultation_request",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-010",
  "timestamp": "2026-03-26T14:30:00Z",
  "payload": {
    "mode": "batch",
    "summary": "Found 5 AI Agent papers worth attention",
    "item_count": 5,
    "urgency": "normal",
    "initial_message": "I just completed a round of arXiv scanning...\n\n### Overview\n1. [Important] Multi-Agent Planning with LLM...\n2. ...",
    "context": {
      "total_scanned": 87,
      "rule_filtered": 23,
      "agent_filtered": 5,
      "time_range": "Last 12 hours"
    }
  }
}
```

| Payload Field | Required | Type | Description |
|---------------|----------|------|-------------|
| `mode` | Yes | string | `batch` / `realtime` / `periodic` |
| `summary` | Yes | string | One-sentence summary |
| `item_count` | Yes | number | Number of report items |
| `urgency` | No | string | `urgent` / `normal` / `low` (defaults to `normal`) |
| `initial_message` | Yes | string | Full report content (natural language, serves as the first user message of the consultation session) |
| `context` | No | object | Additional context (statistics, etc.) |

**Brain response:** Brain replies via `consultation_reply` after creating the consultation session.

---

### 3.3 consultation_message

**Trigger:** During an ongoing consultation, when the tentacle needs to send a follow-up message (e.g., answering Brain's questions)

```json
{
  "type": "consultation_message",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-012",
  "timestamp": "2026-03-26T14:31:00Z",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "message": "Sure, the specific methodology of the first paper is...\n\nThey propose a framework called MAPLE..."
  }
}
```

| Payload Field | Required | Type | Description |
|---------------|----------|------|-------------|
| `consultation_id` | Yes | string | Returned by Brain in the first reply |
| `message` | Yes | string | Message content (natural language) |

---

### 3.4 consultation_end

**Trigger:** Tentacle proactively indicates reporting is complete (usually not needed, as Brain sends consultation_close)

```json
{
  "type": "consultation_end",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-015",
  "timestamp": "2026-03-26T14:35:00Z",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "reason": "All follow-up questions have been answered"
  }
}
```

---

### 3.5 status_update

**Trigger:** After each daemon cycle completes / when status changes

```json
{
  "type": "status_update",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-030",
  "timestamp": "2026-03-26T16:00:00Z",
  "payload": {
    "status": "idle",
    "last_daemon_run": "2026-03-26T16:00:00Z",
    "pending_items": 2,
    "next_scheduled_run": "2026-03-27T04:00:00Z",
    "health": "ok",
    "stats": {
      "total_scanned_today": 142,
      "total_filtered_today": 23,
      "llm_calls_today": 8,
      "tokens_used_today": 12400
    }
  }
}
```

| Payload Field | Required | Type | Description |
|---------------|----------|------|-------------|
| `status` | Yes | string | `idle` / `running` / `paused` / `error` |
| `last_daemon_run` | Yes | string | Last daemon execution time |
| `pending_items` | Yes | number | Pending report queue length |
| `next_scheduled_run` | No | string | Next scheduled execution time |
| `health` | Yes | string | `ok` / `degraded` / `error` |
| `stats` | No | object | Runtime statistics |

---

### 3.6 heartbeat_ack

**Trigger:** After receiving Brain's `heartbeat_ping`, must respond within 10 seconds

```json
{
  "type": "heartbeat_ack",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-050",
  "timestamp": "2026-03-26T16:05:00Z",
  "payload": {}
}
```

---

### 3.7 tool_request

**Trigger:** When the tentacle's Agent Loop needs to call a shared tool (`openceph_` prefix)

```json
{
  "type": "tool_request",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-040",
  "timestamp": "2026-03-26T14:31:00Z",
  "payload": {
    "tool_name": "openceph_web_search",
    "tool_call_id": "call_abc123",
    "arguments": {
      "query": "MAPLE multi-agent planning framework"
    }
  }
}
```

| Payload Field | Required | Type | Description |
|---------------|----------|------|-------------|
| `tool_name` | Yes | string | Shared tool name (`openceph_` prefix) |
| `tool_call_id` | Yes | string | tool_call ID returned by LLM |
| `arguments` | Yes | object | Tool parameters |

---

## 4. Brain → Tentacle Messages

### 4.1 consultation_reply

**Trigger:** Brain replies during a consultation session

```json
{
  "type": "consultation_reply",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-011",
  "timestamp": "2026-03-26T14:30:30Z",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "message": "The first paper looks good. What is the specific methodology of this MAPLE framework? How does it differ from ReAct?",
    "actions_taken": [],
    "continue": true
  }
}
```

**Reply example after Brain pushes to user:**

```json
{
  "type": "consultation_reply",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-013",
  "timestamp": "2026-03-26T14:32:00Z",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "message": "I've pushed the first paper to the user. The second paper's benchmark improvement is too small, not pushing. Can you check the experimental setup of the third paper?",
    "actions_taken": [
      {
        "action": "pushed_to_user",
        "item_ref": "Paper 1: Multi-Agent Planning with LLM",
        "push_id": "p-uuid-001"
      }
    ],
    "continue": true
  }
}
```

| Payload Field | Required | Type | Description |
|---------------|----------|------|-------------|
| `consultation_id` | Yes | string | Consultation session ID |
| `message` | Yes | string | Brain's reply content |
| `actions_taken` | Yes | array | List of actions Brain has taken |
| `actions_taken[].action` | Yes | string | Action type: `pushed_to_user` / `queued_for_digest` |
| `actions_taken[].item_ref` | Yes | string | Description of the corresponding item |
| `actions_taken[].push_id` | No | string | Push ID |
| `continue` | Yes | boolean | `true` = continue conversation; `false` = end |

---

### 4.2 consultation_close

**Trigger:** Brain decides to end the consultation session

```json
{
  "type": "consultation_close",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-020",
  "timestamp": "2026-03-26T14:35:00Z",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "summary": "This report has been fully processed. Pushed 2 papers to user, 3 archived.",
    "pushed_count": 2,
    "discarded_count": 3,
    "feedback": "For future paper filtering, focus more on methodological innovation; pure benchmark improvements have limited reference value."
  }
}
```

| Payload Field | Required | Type | Description |
|---------------|----------|------|-------------|
| `consultation_id` | Yes | string | Consultation session ID |
| `summary` | Yes | string | Processing result summary |
| `pushed_count` | Yes | number | Number of items pushed to user |
| `discarded_count` | Yes | number | Number of items discarded |
| `feedback` | No | string | Brain's suggestions for the tentacle's future work |

**Upon receiving this, the tentacle should:**
1. Clear submitted content from the pending queue
2. Write the consultation record to `reports/submitted/`
3. Update `workspace/STATUS.md` and `workspace/REPORTS.md`
4. If `feedback` is provided, log it for reference during future Agent activations

---

### 4.3 directive

**Trigger:** When Brain needs to control tentacle behavior (can happen at any time)

```json
{
  "type": "directive",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-100",
  "timestamp": "2026-03-26T22:00:00Z",
  "payload": {
    "action": "pause",
    "reason": "User requested pause",
    "params": {}
  }
}
```

| action | Must Handle | Description | params |
|--------|-------------|-------------|--------|
| `pause` | Yes | Pause daemon loop and Agent activation | None |
| `resume` | Yes | Resume operation | None |
| `kill` | Yes | Graceful exit (clean up resources then exit 0) | None |
| `run_now` | No | Immediately trigger one daemon execution | None |
| `config_update` | No | Update configuration | `{ "key": "value" }` |
| `flush_pending` | No | Force submit pending content to consultation | None |

---

### 4.4 heartbeat_ping

**Trigger:** Brain periodically checks tentacle liveness

```json
{
  "type": "heartbeat_ping",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-200",
  "timestamp": "2026-03-26T16:05:00Z",
  "payload": {}
}
```

The tentacle must reply with `heartbeat_ack` within 10 seconds, otherwise Brain will mark the tentacle as unhealthy.

---

### 4.5 tool_result

**Trigger:** After Brain has executed a shared tool requested by the tentacle

```json
{
  "type": "tool_result",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-041",
  "timestamp": "2026-03-26T14:31:05Z",
  "payload": {
    "tool_call_id": "call_abc123",
    "result": {
      "content": "Search results: MAPLE (Multi-Agent Planning via Language-based Exploration) is..."
    },
    "success": true,
    "error": null
  }
}
```

| Payload Field | Required | Type | Description |
|---------------|----------|------|-------------|
| `tool_call_id` | Yes | string | Corresponds to the ID from tool_request |
| `result` | Yes | object | Tool execution result |
| `success` | Yes | boolean | Whether execution succeeded |
| `error` | No | string | Failure reason (when success=false) |

---

## 5. Message Sequence Diagrams

### 5.1 Normal Consultation Flow

```
Tentacle                            Brain                            User
 │                                    │                                │
 │ tentacle_register ───────────────→ │                                │
 │                                    │ (mark as running)              │
 │                                    │                                │
 │ ... daemon running, accumulating   │                                │
 │     data ...                       │                                │
 │                                    │                                │
 │ consultation_request ────────────→ │                                │
 │   (initial_message: report)        │                                │
 │                                    │ (create consultation session)  │
 │                                    │ (load CONSULTATION.md prompt)  │
 │                                    │                                │
 │ ←──────────── consultation_reply   │                                │
 │   (message: "Tell me more about    │                                │
 │    the first paper?")              │                                │
 │   (continue: true)                 │                                │
 │                                    │                                │
 │ consultation_message ────────────→ │                                │
 │   (answering Brain's question)     │                                │
 │                                    │ (decision: worth pushing)      │
 │                                    │ send_to_user() ──────────────→ │
 │                                    │                                │ User receives push
 │ ←──────────── consultation_reply   │                                │
 │   (actions_taken: pushed_to_user)  │                                │
 │   (message: "Pushed. Not pushing   │                                │
 │    the second one.")               │                                │
 │   (continue: true)                 │                                │
 │                                    │                                │
 │ ←──────────── consultation_close   │                                │
 │   (pushed: 1, discarded: 1)        │                                │
 │                                    │                                │
 │ status_update ──────────────────→  │                                │
 │   (status: idle, pending: 0)       │                                │
```

### 5.2 Shared Tool Call Flow

```
Tentacle Agent Loop                        Brain
 │                                          │
 │ (LLM returns tool_calls:                │
 │  openceph_web_search)                   │
 │                                          │
 │ tool_request ──────────────────────────→ │
 │   (tool_name: openceph_web_search)       │
 │                                          │ (execute web search)
 │                                          │
 │ ←────────────────────────── tool_result  │
 │   (result: search results)               │
 │                                          │
 │ (put result into messages,              │
 │  continue Agent Loop)                   │
```
