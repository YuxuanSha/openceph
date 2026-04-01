# Consultation Session Protocol Complete Reference

**File location:** `contracts/skill-tentacle-spec/reference/consultation-protocol.md`
**Purpose:** Complete interaction flow for Consultation Sessions between tentacles and Brain

---

## 1. Overview

A Consultation Session is a multi-turn conversation between a tentacle Agent and the Brain Agent. The tentacle acts as the "user" reporting findings, while Brain acts as the "assistant" reading, asking follow-up questions, and making push decisions.

**Key characteristics:**
- Brain can call `send_to_user` to push content to the user **at any time** during the conversation, without waiting for the conversation to end
- Brain can ask the tentacle for details, and the tentacle answers using its own Agent capabilities (calling LLMs, calling tools)
- A single consultation can process multiple report items

---

## 2. Complete Flow

```
Tentacle (has accumulated enough items / has urgent item)
  │
  │ Second-layer Agent activates, analyzes accumulated content
  │ Organizes into a structured report
  │
  ▼
Step 1: Tentacle sends consultation_request
  │     payload.initial_message = full report content
  │
  ▼
Step 2: Brain creates Consultation Session
  │     · Generates consultation_id
  │     · Loads ~/.openceph/workspace/CONSULTATION.md template
  │     · Fills placeholders (tentacle info, user memory, preferences)
  │     · Uses initial_message as the first "user" message
  │
  ▼
Step 3: Brain processes the report
  │     Brain reads the content and may take the following actions:
  │     (a) Call send_to_user → push important info to user
  │     (b) Reply to tentacle asking for details
  │     (c) Inform tentacle that certain content will not be pushed
  │     → Sends consultation_reply
  │
  ▼
Step 4: Tentacle receives reply
  │     Checks payload.continue:
  │     · true → Brain has follow-up questions, process and send consultation_message
  │     · false → Go to Step 6
  │     Checks payload.actions_taken:
  │     · Record which items were pushed, which were discarded
  │
  ▼
Step 5: Multi-turn conversation (repeat Steps 3-4)
  │     · Brain asks → tentacle answers → Brain makes further decisions
  │     · Brain may push to user at any time (reflected in actions_taken)
  │     · Until Brain sends continue=false or consultation_close
  │
  ▼
Step 6: Consultation ends
  │     Brain sends consultation_close
  │     Tentacle upon receiving:
  │     · Clears submitted content from pending queue
  │     · Writes to reports/submitted/ for archival
  │     · Updates workspace/STATUS.md
  │     · Updates workspace/REPORTS.md
  │     · If feedback is provided, records it for future Agent reference
  │
  ▼
Tentacle returns to first-layer daemon loop
```

---

## 3. Tentacle-Side Implementation Details

### 3.1 Initiating a Consultation

```python
# When accumulated content reaches the threshold
if len(pending) >= config.batch_threshold:
    # First use Agent to analyze and filter
    consultation_items = activate_agent(pending)

    if consultation_items:
        # Organize report content
        report = format_consultation_report(consultation_items)

        # Initiate consultation
        ipc.consultation_request(
            mode="batch",
            summary=f"Found {len(consultation_items)} items worth attention",
            initial_message=report,
            context={"total_scanned": db.get_stat("total_scanned")},
        )
        pending = []  # Clear submitted pending items
```

### 3.2 Handling Brain Follow-Up Questions

```python
@ipc.on_consultation_reply
def handle_reply(consultation_id, message, actions_taken, should_continue):
    # Record Brain's actions
    for action in actions_taken:
        if action["action"] == "pushed_to_user":
            log.consultation("item_pushed", item_ref=action["item_ref"])

    if not should_continue:
        return  # Brain has no more questions

    # Brain asked a follow-up question; need to answer
    # Use Agent capabilities to get details
    answer = answer_brain_question(message, consultation_id)
    ipc.consultation_message(consultation_id, answer)


def answer_brain_question(question, consultation_id):
    """Use Agent capabilities to answer Brain's follow-up question"""
    llm = LlmClient()
    tools = load_tools("tools/tools.json")

    # Can start a small Agent Loop to answer
    agent = AgentLoop(
        system_prompt=f"You are answering Brain's follow-up question. Question: {question}",
        tools=tools,
        max_turns=5,
        ipc=ipc,
    )
    return agent.run(
        user_message=question,
        tool_executor=my_tool_executor,
    )
```

### 3.3 Handling Consultation End

```python
@ipc.on_consultation_close
def handle_close(consultation_id, summary, pushed_count, discarded_count, feedback):
    log.consultation("ended",
        id=consultation_id,
        pushed=pushed_count,
        discarded=discarded_count,
    )

    # Archive
    archive_data = {
        "consultation_id": consultation_id,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "items_count": pushed_count + discarded_count,
        "pushed_count": pushed_count,
        "discarded_count": discarded_count,
        "brain_feedback": feedback,
    }
    archive_path = Path(config.tentacle_dir) / "reports" / "submitted" / f"{date_str}-{consultation_id}.json"
    archive_path.write_text(json.dumps(archive_data, ensure_ascii=False, indent=2))

    # Update workspace files
    update_status_md()
    append_to_reports_md(consultation_id, pushed_count, discarded_count, feedback)

    # If feedback is provided, save it for future Agent reference
    if feedback:
        db.set_state("last_brain_feedback", feedback)
```

---

## 4. Report Content Format Recommendations

The initial_message is natural language, but the following structured format is recommended for easier Brain reading:

```
I just completed a round of {data source} scanning, filtering {N} items worth attention from {total} entries.

### Overview
- Scan range: {time range}
- Total scanned: {total}
- Rule filtered: {rule filtered count}
- Retained after Agent deep read: {N}

### Detailed Findings

1. **[Important] {Title}**
   {2-3 sentence summary}
   Importance level: important
   Reason: {Why it is worth pushing to the user}
   Link: {URL}

2. **[Reference] {Title}**
   {Summary}
   Importance level: reference
   Reason: {Why it is retained but not urgent}
   Link: {URL}

3. ...
```

---

## 5. Consultation Session Timeouts and Limits

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxTurns` | 20 | Maximum conversation turns (Brain forces close if exceeded) |
| `maxAgeMinutes` | 30 | Maximum duration (Brain forces close if exceeded) |
| `replyTimeout` | 120s | Tentacle reply timeout (Brain assumes tentacle cannot answer if exceeded) |

These parameters are configured in `tentacle.consultation` within `openceph.json`.

---

## 6. Urgent Consultation

When a tentacle discovers urgent content (e.g., uptime-watchdog detects a service outage):

```python
ipc.consultation_request(
    mode="realtime",        # Not batch
    summary="Urgent: API endpoint unreachable",
    urgency="urgent",       # Marked as urgent
    initial_message="🚨 Detected https://api.myapp.com/health returning 503...",
    context={},
)
```

Brain processes consultations with `urgency: "urgent"` immediately (skipping the queue) and typically pushes directly to the user.
