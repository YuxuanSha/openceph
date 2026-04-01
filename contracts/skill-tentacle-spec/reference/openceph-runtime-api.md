# openceph-runtime Python Library API Reference

**File location:** `contracts/skill-tentacle-spec/reference/openceph-runtime-api.md`
**Purpose:** Complete API for the `openceph-runtime` library used by Python tentacles

---

## Installation

```
pip install openceph-runtime
```

Or in `requirements.txt`:
```
openceph-runtime>=1.0.0
```

---

## Module Overview

```python
from openceph_runtime import (
    IpcClient,        # IPC communication client
    LlmClient,        # LLM Gateway call client
    AgentLoop,        # Agent Loop executor
    TentacleLogger,   # Structured logging
    TentacleConfig,   # Configuration loader
    StateDB,          # SQLite state management
    load_tools,       # Load tools.json
)
```

All classes automatically read configuration from environment variables; no manual parameter passing is needed.

---

## IpcClient

### Initialization

```python
ipc = IpcClient()
# Automatically reads the OPENCEPH_TENTACLE_ID environment variable
# Automatically configures stdin/stdout JSON Lines communication
```

### connect()

Starts the stdin listener thread. Call at the beginning of main().

```python
ipc.connect()
```

### register(purpose, runtime)

Registers the tentacle. **Must be called immediately after startup.**

```python
ipc.register(
    purpose="Monitor latest arXiv papers",
    runtime="python",
)
```

### consultation_request(mode, summary, initial_message, context=None)

Initiates a consultation session.

```python
ipc.consultation_request(
    mode="batch",                           # "batch" | "realtime" | "periodic"
    summary="Found 5 papers worth attention",
    initial_message="Full report content...",  # Natural language, serves as the first user message of the consultation
    context={"total_scanned": 87},          # Optional, additional context
)
```

### consultation_message(consultation_id, message)

Sends a follow-up message during a consultation (e.g., answering Brain's follow-up questions).

```python
ipc.consultation_message(
    consultation_id="cs-uuid-001",
    message="The methodology of the first paper is...",
)
```

### status_update(status, pending_items, health, **kwargs)

Sends a status update.

```python
ipc.status_update(
    status="idle",          # "idle" | "running" | "paused" | "error"
    pending_items=2,
    health="ok",            # "ok" | "degraded" | "error"
    next_scheduled_run="2026-03-27T04:00:00Z",  # Optional
)
```

### @ipc.on_directive

Registers a directive handler. **Must handle at least pause, resume, and kill.**

```python
@ipc.on_directive
def handle_directive(action: str, params: dict):
    if action == "pause":
        paused_event.set()
    elif action == "resume":
        paused_event.clear()
    elif action == "kill":
        shutdown_event.set()
    elif action == "run_now":
        run_now_event.set()
    elif action == "config_update":
        update_config(params)
    elif action == "flush_pending":
        flush_pending()
```

### @ipc.on_consultation_reply

Registers a consultation reply handler.

```python
@ipc.on_consultation_reply
def handle_reply(
    consultation_id: str,
    message: str,
    actions_taken: list,
    should_continue: bool,
):
    if not should_continue:
        # Consultation ended
        finalize_consultation(consultation_id)
        return

    # Brain asked a follow-up question; answer using Agent capabilities
    answer = process_brain_question(message)
    ipc.consultation_message(consultation_id, answer)
```

### @ipc.on_consultation_close

Registers a consultation close handler.

```python
@ipc.on_consultation_close
def handle_close(
    consultation_id: str,
    summary: str,
    pushed_count: int,
    discarded_count: int,
    feedback: str | None,
):
    # Clear the pending queue
    clear_submitted_items(consultation_id)
    # Update workspace files
    update_status_md()
    update_reports_md(consultation_id, pushed_count, discarded_count, feedback)
    # Archive
    archive_consultation(consultation_id)
```

### tool_request(tool_name, tool_call_id, arguments) → dict

Requests Brain to execute a shared tool. **Synchronously blocks until result is received.**

```python
result = ipc.tool_request(
    tool_name="openceph_web_search",
    tool_call_id="call_abc123",
    arguments={"query": "MAPLE framework"},
)
# result = {"content": "Search results..."}
```

### close()

Closes the connection. Call before the tentacle exits.

```python
ipc.close()
```

---

## LlmClient

### Initialization

```python
llm = LlmClient()
# Automatically reads OPENCEPH_LLM_GATEWAY_URL and OPENCEPH_LLM_GATEWAY_TOKEN
```

### chat(messages, tools=None, temperature=None, max_tokens=None, model="default") → LlmResponse

Calls the LLM.

```python
response = llm.chat(
    messages=[
        {"role": "system", "content": "You are a paper analysis expert"},
        {"role": "user", "content": "Analyze this paper..."},
    ],
    tools=my_tools,       # Optional, OpenAI function format
    temperature=0.3,      # Optional
    max_tokens=4096,      # Optional
    model="default",      # Optional, uses configured default
)
```

### LlmResponse Object

```python
response.content        # str | None — Text reply
response.tool_calls     # list | None — List of tool_calls
response.finish_reason  # str — "stop" | "tool_calls"
response.usage          # dict — {"prompt_tokens": N, "completion_tokens": N}
response.raw            # dict — Raw API response
```

### tool_call Structure

```python
for tc in response.tool_calls:
    tc.id           # str — "call_abc123"
    tc.name         # str — "search_arxiv"
    tc.arguments    # dict — {"query": "multi-agent"}
```

---

## AgentLoop

### Initialization

```python
from openceph_runtime import AgentLoop, load_tools

tools = load_tools("tools/tools.json")

agent = AgentLoop(
    system_prompt="You are a paper analysis expert...",
    tools=tools,            # Merged list of custom tools + shared tools
    max_turns=20,           # Maximum number of turns
    ipc=ipc,                # IpcClient instance, used for shared tool calls
)
```

### run(user_message, tool_executor) → str

Executes a multi-turn Agent Loop and returns the final conclusion text.

```python
result = agent.run(
    user_message="From the following 23 paper abstracts, select the ones worth recommending:\n\n...",
    tool_executor=my_tool_executor,
)
```

### tool_executor Function Signature

```python
def my_tool_executor(tool_name: str, arguments: dict) -> str:
    """Execute a custom tool and return the result string"""
    if tool_name == "search_arxiv":
        results = arxiv_api.search(arguments["query"])
        return json.dumps(results)
    elif tool_name == "fetch_paper_details":
        paper = arxiv_api.get_paper(arguments["arxiv_id"])
        return json.dumps(paper)
    else:
        return json.dumps({"error": f"Unknown tool: {tool_name}"})
```

**AgentLoop Internal Logic:**
1. Construct messages = [system, user]
2. Call LlmClient.chat(messages, tools)
3. If there are tool_calls:
   - `openceph_` prefix → ipc.tool_request() sends to Brain
   - Others → tool_executor() executes locally
   - Append tool result to messages, go back to step 2
4. If no tool_calls (finish_reason=stop) → return content

---

## TentacleLogger

### Initialization

```python
log = TentacleLogger()
# Automatically writes to logs/daemon.log, logs/agent.log, logs/consultation.log
```

### daemon(event, **kwargs)

Engineering layer logs.

```python
log.daemon("fetch_start", source="arxiv", categories=["cs.AI", "cs.CL"])
log.daemon("fetch_end", items=87, duration_ms=2340)
log.daemon("rule_filter", input=87, output=23)
log.daemon("error", error="Connection timeout", exc_info=True)
log.daemon("cycle_complete", scanned=87, filtered=23, pending=23)
```

### agent(event, **kwargs)

Agent layer logs.

```python
log.agent("activated", pending_count=23)
log.agent("llm_call", model="default", input_tokens=4200, output_tokens=890, duration_ms=3200)
log.agent("tool_call", tool="search_arxiv", arguments={"query": "..."}, duration_ms=450)
log.agent("result", items_kept=5, items_discarded=18)
```

### consultation(event, **kwargs)

Consultation layer logs.

```python
log.consultation("started", id="cs-001", item_count=5)
log.consultation("message_sent", id="cs-001", message_length=1200)
log.consultation("reply_received", id="cs-001", actions=["pushed_to_user"], should_continue=True)
log.consultation("ended", id="cs-001", pushed=2, discarded=3, duration_ms=45000)
```

---

## TentacleConfig

### Initialization

```python
config = TentacleConfig()
# Automatically loads from .env and environment variables
```

### Properties

```python
config.tentacle_id       # str — OPENCEPH_TENTACLE_ID
config.tentacle_dir      # Path — OPENCEPH_TENTACLE_DIR
config.workspace         # Path — OPENCEPH_TENTACLE_WORKSPACE
config.trigger_mode      # str — OPENCEPH_TRIGGER_MODE
config.purpose           # str — Read from tentacle.json
config.poll_interval     # int — Read from tentacle.json (seconds)
config.batch_threshold   # int — Read from SKILL.md consultation.batchThreshold

# Custom configuration (non-OPENCEPH_ prefixed variables read from .env)
config.get("ARXIV_CATEGORIES")        # str
config.get("ARXIV_KEYWORDS")          # str
config.get("MY_CUSTOM_VAR", "default")  # With default value
```

---

## StateDB

### Initialization

```python
db = StateDB()
# Automatically creates a SQLite database at data/state.db
```

### is_processed(key) → bool

Checks whether a given key has already been processed.

```python
if not db.is_processed("arxiv:2403.12345"):
    process_paper(paper)
    db.mark_processed("arxiv:2403.12345")
```

### mark_processed(key)

Marks a key as processed.

### increment_stat(name, value=1)

Increments a statistic counter.

```python
db.increment_stat("total_scanned", 87)
db.increment_stat("agent_activated")  # Default +1
```

### get_stat(name) → int

Gets a statistic value.

```python
total = db.get_stat("total_scanned")  # 1247
```

### set_state(key, value)

Stores an arbitrary state value (JSON serialized).

```python
db.set_state("last_fetch_cursor", "2026-03-26T16:00:00Z")
```

### get_state(key, default=None) → any

Gets a state value.

```python
cursor = db.get_state("last_fetch_cursor")
```

---

## load_tools(path) → list

Loads a tools.json file and returns a list of tools in OpenAI function format. Automatically appends shared tool definitions.

```python
from openceph_runtime import load_tools

tools = load_tools("tools/tools.json")
# Returns: custom tools list + openceph_web_search + openceph_web_fetch + ...
```
