#!/usr/bin/env python3
"""
Template Monitor — OpenCeph skill_tentacle complete template

This is a ready-to-run Python tentacle template.
Replace the implementations of fetch_new_data(), rule_filter(), and execute_my_tool().

Three-layer architecture:
  Layer 1 — Engineering Daemon (while loop, pure code, no token consumption)
  Layer 2 — Agent Capabilities (activate LLM for analysis on demand)
  Layer 3 — Consultation (multi-turn conversation reporting to Brain)
"""

import os
import sys
import json
import signal
import threading
from pathlib import Path
from datetime import datetime, timezone

from dotenv import load_dotenv
load_dotenv()

from openceph_runtime import (
    IpcClient,
    LlmClient,
    AgentLoop,
    TentacleLogger,
    TentacleConfig,
    StateDB,
    load_tools,
)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Configuration
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

config = TentacleConfig()
log = TentacleLogger()

# Read custom configuration from .env
TOPICS = [t.strip() for t in config.get("MONITOR_TOPICS", "AI,LLM").split(",") if t.strip()]
BATCH_THRESHOLD = config.batch_threshold  # Read from SKILL.md consultation.batchThreshold
POLL_INTERVAL = int(config.get("POLL_INTERVAL_SECONDS", "21600"))  # Default 6h

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Global State
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_shutdown = threading.Event()
_paused = threading.Event()
_run_now = threading.Event()

signal.signal(signal.SIGTERM, lambda *_: _shutdown.set())
signal.signal(signal.SIGINT, lambda *_: _shutdown.set())

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# IPC Initialization
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ipc = IpcClient()


@ipc.on_directive
def handle_directive(action: str, params: dict):
    """Handle directives issued by the Brain"""
    log.daemon("directive_received", action=action)
    if action == "pause":
        _paused.set()
    elif action == "resume":
        _paused.clear()
    elif action == "kill":
        _shutdown.set()
    elif action == "run_now":
        _run_now.set()
    elif action == "flush_pending":
        _run_now.set()  # Trigger one execution; the Agent will submit all pending items


@ipc.on_consultation_reply
def handle_consultation_reply(
    consultation_id: str,
    message: str,
    actions_taken: list,
    should_continue: bool,
):
    """Handle replies from the Brain during a consultation"""
    # Record actions taken by the Brain
    for action in actions_taken:
        if action.get("action") == "pushed_to_user":
            log.consultation("item_pushed",
                id=consultation_id,
                item_ref=action.get("item_ref", ""),
                push_id=action.get("push_id", ""),
            )

    if not should_continue:
        log.consultation("brain_done", id=consultation_id)
        return

    # Brain asked a follow-up question; use Agent capability to answer
    log.consultation("brain_question", id=consultation_id, question=message[:100])
    answer = answer_brain_question(message)
    ipc.consultation_message(consultation_id, answer)


@ipc.on_consultation_close
def handle_consultation_close(
    consultation_id: str,
    summary: str,
    pushed_count: int,
    discarded_count: int,
    feedback: str | None,
):
    """Consultation ended; clean up and archive"""
    log.consultation("ended",
        id=consultation_id,
        pushed=pushed_count,
        discarded=discarded_count,
    )

    # Archive
    submitted_dir = Path(config.tentacle_dir) / "reports" / "submitted"
    submitted_dir.mkdir(parents=True, exist_ok=True)
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    archive_path = submitted_dir / f"{date_str}-{consultation_id[:8]}.json"
    archive_path.write_text(json.dumps({
        "consultation_id": consultation_id,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "pushed_count": pushed_count,
        "discarded_count": discarded_count,
        "brain_feedback": feedback,
    }, ensure_ascii=False, indent=2))

    # Save feedback for future Agent reference
    if feedback:
        db.set_state("last_brain_feedback", feedback)

    # Update workspace files
    update_status_md()
    update_reports_md(consultation_id, pushed_count, discarded_count, feedback)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Layer 1: Engineering Daemon Logic (replace these functions)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def fetch_new_data() -> list[dict]:
    """
    Fetch new data from the data source.
    Pure engineering code; does not consume LLM tokens.
    Returns a list of raw data items.

    [Replace this function with your data source fetching logic]
    """
    # Example: return an empty list
    log.daemon("fetch_start", source="template", topics=TOPICS)
    items = []
    # TODO: Implement your data fetching logic
    # items = your_api.fetch(topics=TOPICS, since=last_fetch_time)
    log.daemon("fetch_end", items=len(items))
    return items


def rule_filter(items: list[dict]) -> list[dict]:
    """
    Rule-based pre-filtering.
    Pure code logic; does not consume LLM tokens.
    Returns items that pass the filter.

    [Replace this function with your filtering rules]
    """
    filtered = []
    for item in items:
        if db.is_processed(item.get("id", "")):
            continue
        # TODO: Implement your filtering rules
        # if item["score"] >= MIN_SCORE and keyword_match(item, TOPICS):
        #     filtered.append(item)
        filtered.append(item)
        db.mark_processed(item.get("id", ""))
    log.daemon("rule_filter", input=len(items), output=len(filtered))
    return filtered


def execute_my_tool(tool_name: str, arguments: dict) -> str:
    """
    Execute a custom tool.
    When the LLM returns tool_calls in the Agent Loop, tools without
    the openceph_ prefix are executed here.

    [Replace this function with your tool implementations]
    """
    if tool_name == "fetch_items":
        # TODO: Implement
        return json.dumps({"results": [], "count": 0})
    elif tool_name == "get_item_details":
        # TODO: Implement
        return json.dumps({"error": "not implemented"})
    else:
        return json.dumps({"error": f"Unknown tool: {tool_name}"})


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Layer 2: Agent Logic
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def activate_agent(pending_items: list[dict]) -> list[dict]:
    """Activate the Agent to analyze accumulated data; returns items worth reporting"""
    log.agent("activated", pending_count=len(pending_items))

    tools = load_tools("tools/tools.json")
    system_prompt = (Path(config.workspace) / "SYSTEM.md").read_text()

    agent = AgentLoop(
        system_prompt=system_prompt,
        tools=tools,
        max_turns=20,
        ipc=ipc,
    )

    user_message = format_items_for_agent(pending_items)
    result = agent.run(
        user_message=user_message,
        tool_executor=execute_my_tool,
    )

    consultation_items = parse_agent_result(result)
    log.agent("result", items_kept=len(consultation_items), items_discarded=len(pending_items) - len(consultation_items))
    return consultation_items


def answer_brain_question(question: str) -> str:
    """Answer follow-up questions from the Brain during a consultation using Agent capability"""
    llm = LlmClient()
    system_prompt = (Path(config.workspace) / "SYSTEM.md").read_text()

    # Simple case: call LLM directly to answer
    response = llm.chat([
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"The Brain asked the following question, please answer:\n\n{question}"},
    ])
    return response.content


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Helper Functions
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def format_items_for_agent(items: list[dict]) -> str:
    """Format accumulated items as input for the Agent"""
    lines = [f"The following {len(items)} items are pending analysis:\n"]
    for i, item in enumerate(items, 1):
        lines.append(f"{i}. {item.get('title', 'Unknown title')}")
        if item.get("summary"):
            lines.append(f"   {item['summary']}")
        if item.get("url"):
            lines.append(f"   Link: {item['url']}")
        lines.append("")
    lines.append("Please analyze each item and determine which are worth reporting to the Brain and which can be discarded.")
    return "\n".join(lines)


def parse_agent_result(result: str) -> list[dict]:
    """Parse the Agent's analysis result and extract items worth reporting"""
    # Simple implementation: return the Agent's raw result as a single item
    # In practice, parse the Agent's structured output
    return [{"content": result, "judgment": "reference"}]


def format_consultation_report(items: list[dict]) -> str:
    """Format the consultation report content"""
    lines = [f"I just completed a scan and filtered out {len(items)} noteworthy items.\n"]
    for i, item in enumerate(items, 1):
        judgment = item.get("judgment", "reference")
        label = "Important" if judgment == "important" else "Reference"
        lines.append(f"{i}. **[{label}]** {item.get('title', '')}")
        lines.append(f"   {item.get('content', '')[:200]}")
        if item.get("url"):
            lines.append(f"   Link: {item['url']}")
        lines.append("")
    return "\n".join(lines)


def update_status_md():
    """Update workspace/STATUS.md"""
    status_path = Path(config.workspace) / "STATUS.md"
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    content = f"""# {config.get("TENTACLE_DISPLAY_NAME", config.tentacle_id)} — Runtime Status

## Current Status
- **Runtime Status:** Running normally
- **Last engineering layer execution:** {now}
- **Current pending report queue:** 0 items

## Statistics
- Total scanned: {db.get_stat("total_scanned")}
- Total reported: {db.get_stat("total_reported")}
"""
    status_path.write_text(content)


def update_reports_md(consultation_id, pushed_count, discarded_count, feedback):
    """Append consultation record to workspace/REPORTS.md"""
    reports_path = Path(config.workspace) / "REPORTS.md"
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")

    entry = f"\n## {now} — Consultation #{consultation_id[:8]}\n"
    entry += f"- Pushed {pushed_count} items, discarded {discarded_count} items\n"
    if feedback:
        entry += f"- Brain feedback: {feedback}\n"

    if reports_path.exists():
        content = reports_path.read_text()
    else:
        content = "# Historical Report Log\n"
    content += entry
    reports_path.write_text(content)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Main Loop
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

db = StateDB()


def main():
    pending = []

    # IPC connection and registration
    ipc.connect()
    ipc.register(purpose=config.purpose, runtime="python")
    log.daemon("started", trigger_mode=config.trigger_mode, poll_interval=POLL_INTERVAL)

    while not _shutdown.is_set():
        # Pause check
        if _paused.is_set():
            _paused.wait(timeout=60)
            continue

        try:
            # --- Layer 1: Engineering Daemon ---
            raw = fetch_new_data()
            filtered = rule_filter(raw)
            pending.extend(filtered)
            db.increment_stat("total_scanned", len(raw))

            log.daemon("cycle_complete",
                scanned=len(raw),
                filtered=len(filtered),
                pending=len(pending),
            )

            # --- Determine whether to activate Layer 2 ---
            if len(pending) >= BATCH_THRESHOLD:
                log.agent("activating", pending_count=len(pending))

                # --- Layer 2: Agent Analysis ---
                consultation_items = activate_agent(pending)

                if consultation_items:
                    # --- Layer 3: Initiate Consultation ---
                    report = format_consultation_report(consultation_items)
                    ipc.consultation_request(
                        mode="batch",
                        summary=f"Found {len(consultation_items)} noteworthy items",
                        initial_message=report,
                        context={
                            "total_scanned": db.get_stat("total_scanned"),
                            "time_range": "latest cycle",
                        },
                    )
                    db.increment_stat("total_reported", len(consultation_items))
                    pending = []

            # --- Status Update ---
            ipc.status_update(
                status="idle",
                pending_items=len(pending),
                health="ok",
            )
            update_status_md()

        except Exception as e:
            log.daemon("error", error=str(e), exc_info=True)

        # Wait for next trigger
        _run_now.wait(timeout=POLL_INTERVAL)
        _run_now.clear()

    # --- Graceful Shutdown ---
    if pending:
        log.daemon("flushing_pending", count=len(pending))
    ipc.close()
    log.daemon("stopped")


if __name__ == "__main__":
    if "--dry-run" in sys.argv:
        print(f"✓ Tentacle ID: {os.environ.get('OPENCEPH_TENTACLE_ID', 'NOT SET')}")
        print(f"✓ LLM Gateway: {os.environ.get('OPENCEPH_LLM_GATEWAY_URL', 'NOT SET')}")
        print(f"✓ Workspace: {os.environ.get('OPENCEPH_TENTACLE_WORKSPACE', 'NOT SET')}")
        print(f"✓ Topics: {TOPICS}")
        print(f"✓ Batch threshold: {BATCH_THRESHOLD}")
        print(f"✓ Poll interval: {POLL_INTERVAL}s")
        sys.exit(0)
    main()
