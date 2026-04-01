# OpenCeph skill_tentacle Specification Document

**This document is the authoritative specification for Claude Code when generating or modifying skill_tentacles.**
**Before starting any work, you must read this file in its entirety as well as all reference files in the `reference/` directory.**

---

## Table of Contents

- [1. Overview](#1-overview)
- [2. Directory Structure Specification](#2-directory-structure-specification)
- [3. Three-Layer Architecture Specification](#3-three-layer-architecture-specification)
- [4. SKILL.md Specification](#4-skillmd-specification)
- [5. IPC Communication Specification](#5-ipc-communication-specification)
- [6. LLM Gateway Invocation Specification](#6-llm-gateway-invocation-specification)
- [7. openceph-runtime Library Usage Specification](#7-openceph-runtime-library-usage-specification)
- [8. Workspace File Specification](#8-workspace-file-specification)
- [9. Tool System Specification](#9-tool-system-specification)
- [10. Logging Specification](#10-logging-specification)
- [11. Absolute Prohibition List](#11-absolute-prohibition-list)
- [12. Validation Checklist](#12-validation-checklist)

**Supplementary reference files (consult the `reference/` directory as needed):**
- `reference/ipc-protocol.md` — Complete IPC message format definitions
- `reference/llm-gateway-api.md` — Complete LLM Gateway HTTP API reference
- `reference/workspace-structure.md` — Complete workspace directory specification
- `reference/openceph-runtime-api.md` — Complete openceph-runtime library API reference
- `reference/consultation-protocol.md` — Complete consultation session protocol reference

**Runnable complete templates (refer to the `examples/` directory as needed):**
- `examples/python-template/` — Complete runnable Python tentacle template
- `examples/typescript-template/` — Complete runnable TypeScript tentacle template

---

## 1. Overview

A skill_tentacle is a long-running Agent program within the OpenCeph system. Each tentacle is an independent subprocess with three layers of capability: an Engineering Daemon (continuously running), Agent capability (LLM reasoning), and Consultation capability (dialogue with the Brain).

Tentacles communicate with the Brain via stdin/stdout (IPC) and call the LLM Gateway over HTTP to access model capabilities. Tentacles must not contact the user directly; all user-facing communication must go through the Brain.

---

## 2. Directory Structure Specification

Generated or modified skill_tentacles must follow this directory structure:

```
{tentacle_dir}/
├── SKILL.md                    # [Required] Blueprint metadata
├── README.md                   # [Recommended] Development notes
│
├── prompt/                     # [Required] Agent prompt files
│   └── SYSTEM.md               # [Required] Tentacle Agent's system prompt
│
├── src/                        # [Required] Engineering code
│   ├── main.py                 # [Required] Python entry point (or index.ts)
│   └── requirements.txt        # [Required] Python dependencies (or package.json)
│
├── tools/                      # [Required if custom tools exist]
│   └── tools.json              # Tool definitions (OpenAI function format)
│
├── workspace/                  # [Created automatically at runtime]
│   ├── SYSTEM.md               # Populated from prompt/SYSTEM.md
│   ├── STATUS.md               # Runtime status maintained by the tentacle
│   └── REPORTS.md              # Historical report summaries
│
├── data/                       # [Created automatically at runtime]
│   └── state.db                # SQLite database
│
├── reports/                    # [Created automatically at runtime]
│   ├── pending/                # Content awaiting report
│   └── submitted/              # Archived submitted reports
│
├── logs/                       # [Created automatically at runtime]
│   ├── daemon.log              # Engineering layer logs
│   ├── agent.log               # Agent layer logs
│   └── consultation.log        # Consultation logs
│
└── .env                        # [Auto-generated at deployment, do not create manually]
```

---

## 3. Three-Layer Architecture Specification

Every tentacle must implement the three-layer architecture. **The three layers must not be mixed together.**

### Layer 1: Engineering Daemon

- Continuously running main loop
- Pure code logic, **does not consume LLM tokens**
- Responsible for: data fetching, rule-based filtering, deduplication, accumulation
- Triggered on a timer or by events
- Implemented with a `while not shutdown` loop

### Layer 2: Agent Capability

- Activated by policy (accumulation reaches threshold, urgent items exist, too long since last activation)
- Calls the LLM Gateway for analysis, judgment, and generation
- Uses `workspace/SYSTEM.md` as the system prompt
- Supports tool calls (custom tools + shared tools)
- Results are used to prepare consultation content

### Layer 3: Consultation

- Initiated when the Agent layer identifies content worth reporting
- Sends a `consultation_request` via IPC
- Acts as the "user" in a multi-turn dialogue with the Brain during the consultation session
- Handles follow-up questions from the Brain (may need to invoke Agent capability again for details)
- Cleans up the pending queue after receiving `consultation_close`

### Main Loop Pseudocode (this structure must be followed)

```python
from openceph_runtime import IpcClient, LlmClient, AgentLoop, TentacleLogger, StateDB

ipc = IpcClient()
log = TentacleLogger()

def main():
    ipc.connect()
    ipc.register(purpose="...", runtime="python")

    pending = []

    while not shutdown:
        if paused:
            wait(60)
            continue

        # ─── Layer 1: Engineering Daemon ───
        raw_items = fetch_new_data()          # Pure code, no LLM calls
        filtered = rule_filter(raw_items)     # Pure code, no LLM calls
        pending.extend(filtered)

        # ─── Decide whether to activate Layer 2 ───
        if len(pending) >= BATCH_THRESHOLD:

            # ─── Layer 2: Agent ───
            agent_result = run_agent_loop(
                system_prompt=read("workspace/SYSTEM.md"),
                user_message=format_items(pending),
                tools=load_tools("tools/tools.json"),
            )
            consultation_items = parse_result(agent_result)

            if consultation_items:
                # ─── Layer 3: Consultation ───
                ipc.consultation_request(
                    mode="batch",
                    summary=f"Found {len(consultation_items)} items",
                    initial_message=format_report(consultation_items),
                )
                pending = []

        ipc.status_update(status="idle", pending_items=len(pending))
        wait(POLL_INTERVAL)
```

---

## 4. SKILL.md Specification

SKILL.md uses YAML frontmatter and must include the following fields:

```yaml
---
name: tentacle-name              # Required, lowercase with hyphens
description: |                   # Required, multi-line description
  A one-sentence explanation of what this tentacle does.
version: 1.0.0                   # Required, semantic versioning

metadata:
  openceph:
    emoji: "🎓"                  # Required, used for display
    category: "monitoring"       # Required: monitoring | execution | curation | tool
    trigger_keywords:            # Required, used by Brain for matching
      - "keyword1"
      - "keyword2"

    tentacle:
      spawnable: true            # Required
      runtime: python            # Required: python | typescript | go | shell
      entry: src/main.py         # Required, entry file path
      default_trigger: "every 12 hours"  # Required

      setup_commands:            # Required, executed at deployment
        - "python3 -m venv venv"
        - "venv/bin/pip install -r src/requirements.txt"

      requires:
        bins: ["python3"]        # Commands that must be installed on the host
        llm: true                # Whether LLM Gateway is needed
        env: []                  # Additional required environment variable names

      capabilities:
        daemon:                  # Layer 1 capability list
          - "api_integration"
        agent:                   # Layer 2 capability list
          - "content_analysis"
        consultation:            # Layer 3 strategy
          mode: "batch"          # batch | realtime | periodic
          batch_threshold: 5     # Threshold for batch mode

      infrastructure:
        needsDatabase: true
        needsLlm: true
        needsHttpServer: false

      customizable:              # User-configurable fields
        - field: "categories"
          description: "Category list"
          env_var: "MY_CATEGORIES"
          default: "cs.AI,cs.CL"
---
```

---

## 5. IPC Communication Specification

### Transport Layer

- **Protocol:** stdin/stdout JSON Lines
- Each message occupies a single line, terminated by `\n`
- stderr is used for logging and does not participate in IPC
- Encoding: UTF-8

### Message Envelope Format

```json
{
  "type": "<message_type>",
  "tentacle_id": "t_xxx",
  "message_id": "msg-uuid",
  "timestamp": "2026-03-26T16:00:00Z",
  "payload": { }
}
```

### Required Message Types

#### Startup Registration (Tentacle → Brain, sent immediately after startup)

```json
{
  "type": "tentacle_register",
  "tentacle_id": "t_xxx",
  "message_id": "msg-001",
  "timestamp": "...",
  "payload": {
    "purpose": "Description of the tentacle's purpose",
    "runtime": "python",
    "pid": 12346,
    "capabilities": {
      "daemon": ["api_integration"],
      "agent": ["content_analysis"],
      "consultation": { "mode": "batch", "batchThreshold": 5 }
    },
    "tools": ["tool_name_1", "tool_name_2"],
    "version": "1.0.0"
  }
}
```

#### Consultation Request (Tentacle → Brain)

```json
{
  "type": "consultation_request",
  "tentacle_id": "t_xxx",
  "message_id": "msg-010",
  "timestamp": "...",
  "payload": {
    "mode": "batch",
    "summary": "Found 5 items worth attention",
    "item_count": 5,
    "urgency": "normal",
    "initial_message": "Full report content (natural language)...",
    "context": {
      "total_scanned": 87,
      "time_range": "Last 12 hours"
    }
  }
}
```

#### Consultation Message (Tentacle → Brain, subsequent dialogue)

```json
{
  "type": "consultation_message",
  "tentacle_id": "t_xxx",
  "message_id": "msg-012",
  "timestamp": "...",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "message": "Response to Brain's follow-up question..."
  }
}
```

#### Status Update (Tentacle → Brain)

```json
{
  "type": "status_update",
  "tentacle_id": "t_xxx",
  "message_id": "msg-030",
  "timestamp": "...",
  "payload": {
    "status": "idle",
    "last_daemon_run": "2026-03-26T16:00:00Z",
    "pending_items": 2,
    "next_scheduled_run": "2026-03-27T04:00:00Z",
    "health": "ok"
  }
}
```

#### Heartbeat Response (Tentacle → Brain)

```json
{
  "type": "heartbeat_ack",
  "tentacle_id": "t_xxx",
  "message_id": "msg-050",
  "timestamp": "...",
  "payload": {}
}
```

### Required Brain → Tentacle Messages to Handle

#### Directive (Brain → Tentacle)

```json
{
  "type": "directive",
  "tentacle_id": "t_xxx",
  "message_id": "msg-100",
  "timestamp": "...",
  "payload": {
    "action": "pause | resume | kill | run_now | config_update | flush_pending",
    "reason": "Reason description",
    "params": {}
  }
}
```

**Required actions to handle:** `pause`, `resume`, `kill`. Others are optional.

#### Consultation Reply (Brain → Tentacle)

```json
{
  "type": "consultation_reply",
  "tentacle_id": "t_xxx",
  "message_id": "msg-011",
  "timestamp": "...",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "message": "Brain's reply content...",
    "actions_taken": [
      { "action": "pushed_to_user", "item_ref": "Item description", "push_id": "p-001" }
    ],
    "continue": true
  }
}
```

When `continue` is `false`, the consultation ends.

#### Consultation Close (Brain → Tentacle)

```json
{
  "type": "consultation_close",
  "tentacle_id": "t_xxx",
  "message_id": "msg-020",
  "timestamp": "...",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "summary": "Processing results for this report",
    "pushed_count": 2,
    "discarded_count": 3,
    "feedback": "Suggestions for future filtering"
  }
}
```

#### Heartbeat Ping (Brain → Tentacle)

```json
{
  "type": "heartbeat_ping",
  "tentacle_id": "t_xxx",
  "message_id": "msg-200",
  "timestamp": "...",
  "payload": {}
}
```

A `heartbeat_ack` must be sent within 10 seconds of receiving this message.

---

## 6. LLM Gateway Invocation Specification

### Endpoint and Authentication

```
URL:   Environment variable OPENCEPH_LLM_GATEWAY_URL (e.g., http://127.0.0.1:18792)
Token: Environment variable OPENCEPH_LLM_GATEWAY_TOKEN
```

### Request Format (OpenAI-compatible)

```
POST {OPENCEPH_LLM_GATEWAY_URL}/v1/chat/completions
Headers:
  Content-Type: application/json
  Authorization: Bearer {OPENCEPH_LLM_GATEWAY_TOKEN}
  X-Tentacle-Id: {OPENCEPH_TENTACLE_ID}
```

```json
{
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ],
  "model": "default",
  "temperature": 0.3,
  "max_tokens": 4096,
  "tools": [ ],
  "stream": false
}
```

**`model` field:** Pass `"default"` or omit it; the Gateway will use the tentacle model configured in openceph.json.

### Response Format (OpenAI-compatible)

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Reply content",
      "tool_calls": null
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 340,
    "total_tokens": 1540
  }
}
```

### Response with tool_calls

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "search_arxiv",
          "arguments": "{\"query\": \"multi-agent\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

---

## 7. openceph-runtime Library Usage Specification

**Python tentacles must use the `openceph-runtime` library. Do not implement IPC or LLM calls yourself.**

### Installation

Add the following to `requirements.txt`:

```
openceph-runtime>=1.0.0
```

### Core API

```python
from openceph_runtime import (
    IpcClient,        # IPC communication
    LlmClient,        # LLM Gateway calls
    AgentLoop,        # Agent Loop execution
    TentacleLogger,   # Structured logging
    TentacleConfig,   # Configuration loading
    StateDB,          # SQLite state database
    load_tools,       # Load tools.json
)
```

### IpcClient Usage

```python
ipc = IpcClient()  # Automatically reads configuration from env vars

# Register (call immediately after startup)
ipc.register(purpose="Tentacle purpose", runtime="python")

# Initiate a consultation
ipc.consultation_request(
    mode="batch",
    summary="Found 5 items",
    initial_message="Report content...",
    context={"total_scanned": 87},
)

# Send subsequent messages during consultation
ipc.consultation_message(consultation_id, message="Answering follow-up question...")

# Register directive handler
@ipc.on_directive
def handle(action, params):
    if action == "pause": ...
    elif action == "kill": ...

# Register consultation reply handler
@ipc.on_consultation_reply
def handle(consultation_id, message, actions_taken, should_continue):
    if not should_continue:
        # Consultation ended
        return
    # Brain asked a follow-up question, process it
    answer = process_question(message)
    ipc.consultation_message(consultation_id, answer)

# Status update
ipc.status_update(status="idle", pending_items=2, health="ok")
```

### LlmClient Usage

```python
llm = LlmClient()  # Automatically reads Gateway URL and Token from env vars

response = llm.chat([
    {"role": "system", "content": "You are a paper analysis expert"},
    {"role": "user", "content": "Analyze this paper..."},
], temperature=0.3)

print(response.content)       # Text reply
print(response.tool_calls)    # List of tool_calls (may be None)
```

### AgentLoop Usage

```python
tools = load_tools("tools/tools.json")

agent = AgentLoop(
    system_prompt=open("workspace/SYSTEM.md").read(),
    tools=tools,
    max_turns=20,
    ipc=ipc,  # Used for shared tool calls
)

result = agent.run(
    user_message="Analyze the following content...",
    tool_executor=my_local_tool_executor,  # Custom tool execution function
)
```

### TentacleLogger Usage

```python
log = TentacleLogger()

log.daemon("fetch_start", url="...", items=87)
log.agent("llm_call", model="default", input_tokens=1200)
log.consultation("started", consultation_id="cs-001")
```

### StateDB Usage

```python
db = StateDB()  # Automatically creates data/state.db

if not db.is_processed("arxiv:2403.12345"):
    # Process...
    db.mark_processed("arxiv:2403.12345")

db.increment_stat("total_scanned", 87)
```

---

## 8. Workspace File Specification

### workspace/STATUS.md

The tentacle must update this file after each run. The Brain can read it directly.

```markdown
# {Tentacle Name} — Runtime Status

## Current State
- **Running Status:** Running normally | Paused | Error
- **Last Engineering Layer Execution:** {time} (Success | Failure)
- **Last Agent Activation:** {time}
- **Last Report to Brain:** {time} (Pushed N items)
- **Current Pending Report Queue:** N items (threshold M)

## Statistics
- Total scanned: N
- Rule-filtered: N
- Retained after Agent deep-read: N
- Reported to Brain: N
- Pushed to user by Brain: N

## Latest Execution Summary
{Brief description of the most recent execution results}
```

### workspace/REPORTS.md

Brief summaries of historical report records.

```markdown
# Historical Report Records

## 2026-03-26 14:30 — Consultation #cs-001
- Reported 5 items, Brain pushed 2, discarded 3
- Pushed content: Paper A (Multi-Agent Planning), Paper B (Chain-of-Reasoning)
- Brain feedback: Focus more on methodological innovation

## 2026-03-25 20:00 — Consultation #cs-000
- Reported 3 items, Brain pushed 1, discarded 2
```

### prompt/SYSTEM.md

Supports placeholders that are filled by the SkillSpawner at deployment:

| Placeholder | Source |
|-------------|--------|
| `{TENTACLE_NAME}` | SKILL.md name |
| `{TENTACLE_EMOJI}` | SKILL.md emoji |
| `{USER_NAME}` | USER.md username |
| `{USER_FOCUS_AREAS}` | USER.md areas of interest |
| `{QUALITY_CRITERIA}` | Value from customizable fields |
| `{TOOLS_DESCRIPTION}` | Generated from tools.json |

---

## 9. Tool System Specification

### Custom Tools

Defined in `tools/tools.json` using the OpenAI function calling format:

```json
[
  {
    "type": "function",
    "function": {
      "name": "search_arxiv",
      "description": "Search arXiv papers",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "Search keywords" }
        },
        "required": ["query"]
      }
    }
  }
]
```

Custom tools are executed internally by the tentacle's code.

### Shared Tools (provided by openceph)

Tool names are prefixed with `openceph_` and are executed by the Brain via IPC request.

Available shared tools:

| Tool Name | Description |
|-----------|-------------|
| `openceph_web_search` | Web search |
| `openceph_web_fetch` | Fetch web page content |
| `openceph_read_file` | Read file (limited to tentacle workspace) |
| `openceph_write_file` | Write file (limited to tentacle workspace) |

When the Agent Loop receives `tool_calls` returned by the LLM:
- Tool name starts with `openceph_` → Request Brain execution via `ipc.tool_request()`
- Otherwise → Execute locally (custom tool)

---

## 10. Logging Specification

Use `TentacleLogger`. **Do not write logs to files yourself.**

Logs are automatically written to:
- Engineering layer events → `logs/daemon.log`
- Agent layer events → `logs/agent.log`
- Consultation events → `logs/consultation.log`

Format: JSON Lines, one entry per line.

```python
log = TentacleLogger()

# Engineering layer
log.daemon("fetch_start", source="arxiv", categories=["cs.AI"])
log.daemon("fetch_end", items=87, duration_ms=2340)
log.daemon("error", error="Connection timeout", exc_info=True)

# Agent layer
log.agent("activated", pending_count=23)
log.agent("llm_call", model="default", input_tokens=4200, output_tokens=890)
log.agent("tool_call", tool="search_arxiv", arguments={"query": "..."})
log.agent("result", items_kept=5, items_discarded=18)

# Consultation
log.consultation("started", id="cs-001", item_count=5)
log.consultation("ended", id="cs-001", pushed=2, discarded=3)
```

---

## 11. Absolute Prohibition List

The following behaviors are **absolutely prohibited**. Violations will cause validation failure:

| Prohibited Behavior | Reason |
|---------------------|--------|
| Hardcoding API keys (e.g., `OPENROUTER_API_KEY="sk-..."`) | Security risk; must use LLM Gateway |
| Hardcoding provider URLs (e.g., `openrouter.ai/api/v1`) | Must use LLM Gateway |
| Directly calling external LLM APIs (requests.post to openrouter, etc.) | Must use LLM Gateway |
| Implementing IPC communication yourself (raw socket/stdin read/write) | Must use openceph-runtime IpcClient |
| Implementing Agent Loop yourself (without using the AgentLoop class) | Recommended to use openceph-runtime AgentLoop |
| Using `os.system()`, `subprocess.Popen()` | Security risk |
| Using `exec()`, `eval()`, `__import__()` | Security risk |
| Writing to directories outside the tentacle workspace | Permission violation |
| Reading `~/.openceph/credentials/` | Permission violation |
| Reading `~/.openceph/workspace/` (Brain workspace) | Permission violation |
| Sending messages directly to the user (bypassing Brain) | Architecture violation |
| Calling LLM in the Layer 1 daemon | Architecture violation; Layer 1 must not consume tokens |

---

## 12. Validation Checklist

After generating or modifying code, ensure the following checks all pass:

### Structure Checks
- [ ] `src/main.py` (or `index.ts`) exists
- [ ] `SKILL.md` exists with correct frontmatter format
- [ ] `prompt/SYSTEM.md` exists
- [ ] `src/requirements.txt` (or `package.json`) exists
- [ ] If custom tools exist: `tools/tools.json` exists with correct format

### IPC Contract Checks
- [ ] Code contains `from openceph_runtime import IpcClient`
- [ ] `ipc.register()` is called after startup
- [ ] `consultation_request` sending logic is implemented
- [ ] `@ipc.on_directive` handler is registered, handling at minimum `pause`, `resume`, `kill`
- [ ] `@ipc.on_consultation_reply` handler is registered

### LLM Gateway Checks
- [ ] Code contains `from openceph_runtime import LlmClient` (if LLM is needed)
- [ ] No hardcoded API keys or provider URLs
- [ ] No direct calls to external LLM APIs

### Three-Layer Architecture Checks
- [ ] Layer 1 daemon loop exists (while not shutdown)
- [ ] Layer 1 does not call the LLM
- [ ] Layer 2 Agent activation has a clear trigger condition
- [ ] Layer 3 consultation is initiated after Agent filtering

### Security Checks
- [ ] No `os.system()`, `subprocess.Popen()`, `exec()`, `eval()`
- [ ] File writes are limited to the tentacle's own directory

### Dry-run Test
- [ ] `python src/main.py --dry-run` exits successfully (checks configuration and dependencies)

---

*This specification document is the sole authoritative source for Claude Code to generate compliant skill_tentacles.*
*If in doubt, consult the detailed reference files in the `reference/` directory and the runnable templates in the `examples/` directory.*
