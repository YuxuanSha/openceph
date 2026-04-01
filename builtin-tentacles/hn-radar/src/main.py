"""
HN Radar — Hacker News monitoring tentacle for OpenCeph.

Three-layer architecture:
  Layer 1 (Daemon): Multi-feed HN fetch + rule-based pre-filtering + smart dedup
  Layer 2 (Agent):  LLM-based intelligent filtering (default on, core capability)
  Layer 3 (Consultation): Multi-turn dialogue with Brain for push decisions
"""

import os
import signal
import time
import json
import threading
from pathlib import Path
from datetime import datetime, timezone

from openceph_runtime import (
    IpcClient, TentacleConfig, TentacleLogger, StateDB,
    LlmClient, AgentLoop, load_tools,
)
from hn_fetcher import fetch_items
from hn_tools import safe_int
from filter_engine import rule_filter, llm_filter, to_consultation_items

# ─── Globals ───────────────────────────────────────────────────

RUN_NOW = threading.Event()
PAUSED = threading.Event()
SHUTDOWN = threading.Event()
PENDING: list[dict] = []

# Per-consultation context: request_id → submitted items
CONSULTATION_CONTEXT: dict[str, list[dict]] = {}

# Layer 3 consultation answer prompt template (Scene E identity)
CONSULTATION_ANSWER_PROMPT = """You are {tentacle_name}, a Hacker News monitoring and analysis tentacle.
Your boss (Brain/Ceph) is reviewing your report and has a follow-up question.

Boss's question:
{brain_question}

Summary of your last report:
{items_summary}

Use your tools (websearch/webfetch) to look up the needed information, then answer your boss concisely.
Do not repeat the entire report — only answer the part that was asked about."""


DEFAULT_TOPICS = ["AI", "LLM", "agent", "startup"]


def load_topics() -> list[str]:
    raw = os.environ.get("HN_TOPICS", "AI,LLM,agent,startup")
    topics = [t.strip() for t in raw.split(",") if t.strip()]
    # "*" or empty means "all topics" — use defaults for search/LLM context
    if not topics or topics == ["*"]:
        return DEFAULT_TOPICS
    return topics


def load_feeds() -> list[str]:
    return [f.strip() for f in os.environ.get("HN_FEEDS", "newest").split(",") if f.strip()]


def load_system_prompt(config: TentacleConfig) -> str:
    """Load the Layer 2 system prompt from workspace/SYSTEM.md."""
    workspace = config.ensure_workspace()
    prompt_path = Path(workspace) / "SYSTEM.md"
    if prompt_path.exists():
        return prompt_path.read_text(encoding="utf-8")
    # Fallback: try prompt/ directory
    prompt_dir = Path(config.tentacle_dir) / "prompt" / "SYSTEM.md"
    if prompt_dir.exists():
        return prompt_dir.read_text(encoding="utf-8")
    return "You are a Hacker News monitoring agent. Evaluate each post for quality and relevance."


# ─── Layer 1: Daemon ──────────────────────────────────────────

def run_daemon_cycle(state: StateDB, log: TentacleLogger, llm: LlmClient,
                     system_prompt: str) -> tuple[list[dict], list[str]]:
    """
    One fetch-filter cycle. Returns (consultation_items, rejected_ids).
    """
    topics = load_topics()
    feeds = load_feeds()
    fetch_count = int(os.environ.get("HN_FETCH_COUNT", "50"))
    min_score = int(os.environ.get("HN_MIN_SCORE", "0"))
    min_comments = int(os.environ.get("HN_MIN_COMMENTS", "0"))
    use_llm = os.environ.get("USE_LLM_FILTER", "true").lower() == "true"

    # Get last fetch timestamp for Algolia incremental queries
    last_fetch_ts = int(float(state.get_state("last_fetch_ts", "0") or "0"))

    log.daemon("cycle_start", feeds=feeds, topics=topics, use_llm=use_llm,
               min_score=min_score, min_comments=min_comments)

    # --- Fetch ---
    t0 = time.time()
    try:
        raw_items = fetch_items(feeds, topics, fetch_count, last_fetch_ts, log)
    except Exception as e:
        log.error("fetch_failed", error=str(e))
        return [], []
    fetch_ms = int((time.time() - t0) * 1000)
    log.daemon("fetch_complete", raw_items=len(raw_items), duration_ms=fetch_ms)

    # Update last fetch timestamp
    state.set_state("last_fetch_ts", str(int(time.time())))

    # --- Dedup: exclude already reported + already rejected ---
    fresh = [item for item in raw_items if not state.is_processed(str(item["id"]))]
    log.daemon("dedup", raw=len(raw_items), fresh=len(fresh))

    if not fresh:
        log.daemon("cycle_complete", scanned=len(raw_items), fresh=0, filtered=0)
        return [], []

    # --- Layer 1: Rule pre-filter (optional, default 0 = no filtering) ---
    candidates = rule_filter(fresh, topics, min_score, min_comments, log)

    # --- Layer 2: LLM filter (default on) ---
    rejected_ids: list[str] = []
    if use_llm and candidates:
        accepted, rejected_ids = llm_filter(candidates, system_prompt, llm, log)
    else:
        accepted = candidates

    # Only mark LLM-rejected items (won't re-evaluate).
    # Accepted items are marked later in flush_pending when actually submitted to Brain.
    for rid in rejected_ids:
        state.mark_processed(rid)

    # Without LLM: sort by score descending so best items get reported first
    if not use_llm and accepted:
        accepted = sorted(accepted, key=lambda x: safe_int(x.get("score")), reverse=True)

    result = to_consultation_items(accepted[:10])
    log.daemon("cycle_complete", scanned=len(raw_items), fresh=len(fresh),
               candidates=len(candidates), accepted=len(accepted),
               rejected=len(rejected_ids), consultation_items=len(result))
    return result, rejected_ids


# ─── Layer 3: Consultation ────────────────────────────────────

def build_initial_message(summary: str, items: list[dict]) -> str:
    """Build detailed initial_message for consultation_request."""
    lines = [f"{summary}\n"]
    for i, item in enumerate(items, 1):
        lines.append(f"{i}. {item.get('content', item.get('title', '(no title)'))}")
        if item.get("reason"):
            lines.append(f"   Filter reason:{item['reason']}")
        if item.get("importance"):
            lines.append(f"   Importance:{item['importance']}")
        lines.append("")
    return "\n".join(lines)


def flush_pending(ipc: IpcClient, state: StateDB, log: TentacleLogger, findings: list[dict]):
    """Batch and send consultation requests to Brain."""
    global PENDING

    batch_size = int(os.environ.get("BATCH_SIZE", "3"))
    urgent = [f for f in findings if f.get("importance") == "high" and safe_int(f.get("score")) >= 300]
    normal = [f for f in findings if f not in urgent]

    for item in urgent:
        summary = f"[HN Hot Post] {item.get('title', '')}"
        msg = build_initial_message(summary, [item])
        log.consultation("request_sent", mode="urgent", item_count=1,
                         title=str(item.get("title", ""))[:100])
        req_id = ipc.consultation_request(
            mode="batch", summary=summary, initial_message=msg,
            item_count=1, urgency="urgent",
        )
        CONSULTATION_CONTEXT[req_id] = [item]
        # Mark submitted item so it won't reappear
        state.mark_processed(str(item.get("id", "")))
        state.set_state("last_report_at", str(time.time()))

    PENDING.extend(normal)
    last_report_at = float(state.get_state("last_report_at", "0") or "0")
    is_first_run = last_report_at == 0

    should_flush = (
        len(PENDING) >= batch_size
        or (PENDING and (time.time() - last_report_at) >= 24 * 3600)
        or (is_first_run and PENDING)
    )

    if should_flush and PENDING:
        payload = PENDING[:]
        PENDING = []
        summary = f"[HN Radar] Found {len(payload)} noteworthy posts"
        msg = build_initial_message(summary, payload)
        log.consultation("request_sent", mode="batch", item_count=len(payload),
                         titles=[p.get("title", "")[:80] for p in payload])
        req_id = ipc.consultation_request(
            mode="batch", summary=summary, initial_message=msg,
            item_count=len(payload), urgency="normal",
            context={"topics": ",".join(load_topics())},
        )
        CONSULTATION_CONTEXT[req_id] = payload[:]
        # Mark submitted items so they won't reappear
        for item in payload:
            state.mark_processed(str(item.get("id", "")))
        state.set_state("last_report_at", str(time.time()))


def update_status_md(config: TentacleConfig, state: StateDB):
    """Update workspace/STATUS.md."""
    workspace = config.ensure_workspace()
    processed = state.get_processed_count()
    total_reports = int(state.get_state("total_reports", "0") or "0")
    last_report = state.get_state("last_report_at", "never")
    content = f"""# HN Radar Status

- **Status:** running
- **Processed items:** {processed}
- **Total reports:** {total_reports}
- **Last report:** {last_report}
- **Watched topics:** {os.environ.get('HN_TOPICS', 'AI,LLM,agent,startup')}
- **Data sources:** {os.environ.get('HN_FEEDS', 'newest')}
- **LLM filter:** {os.environ.get('USE_LLM_FILTER', 'true')}
- **Updated at:** {datetime.now(timezone.utc).isoformat()}
"""
    try:
        (Path(workspace) / "STATUS.md").write_text(content, encoding="utf-8")
    except Exception:
        pass


def setup_workspace(config: TentacleConfig):
    """Initialize workspace/SYSTEM.md from prompt/SYSTEM.md with placeholder substitution."""
    workspace = Path(config.ensure_workspace())
    prompt_src = Path(config.tentacle_dir) / "prompt" / "SYSTEM.md"
    system_dst = workspace / "SYSTEM.md"

    if prompt_src.exists() and not system_dst.exists():
        content = prompt_src.read_text(encoding="utf-8")
        content = content.replace("{USER_NAME}", os.environ.get("OPENCEPH_USER_NAME", "User"))
        content = content.replace("{HN_TOPICS}", os.environ.get("HN_TOPICS", "AI,LLM,agent,startup"))
        content = content.replace("{LLM_FILTER_CRITERIA}",
                                  os.environ.get("LLM_FILTER_CRITERIA",
                                                 "Filter for content with engineering value."))
        system_dst.write_text(content, encoding="utf-8")

    # Copy CONSULTATION.md (tentacle-specific identity for Layer 3)
    consultation_src = Path(config.tentacle_dir) / "prompt" / "CONSULTATION.md"
    consultation_dst = workspace / "CONSULTATION.md"
    if consultation_src.exists() and not consultation_dst.exists():
        consultation_dst.write_text(consultation_src.read_text(encoding="utf-8"), encoding="utf-8")


# ─── Main ─────────────────────────────────────────────────────

def main():
    config = TentacleConfig()
    log = TentacleLogger()
    state = StateDB()
    llm = LlmClient()
    ipc = IpcClient()

    # Initialize workspace (prompt substitution)
    setup_workspace(config)
    system_prompt = load_system_prompt(config)

    ipc.connect()
    topics_str = ", ".join(load_topics())
    default_purpose = (
        "Monitor Hacker News via multi-feed fetch + LLM filtering. "
        f"Specializes in identifying technically deep content about {topics_str}. "
        "Can answer follow-ups using websearch/webfetch tools."
    )
    ipc.register(
        purpose=os.environ.get("OPENCEPH_PURPOSE", default_purpose),
        runtime="python",
        capabilities={
            "daemon": ["fetch_hn_multi_feed", "rule_filter", "dedup"],
            "agent": ["llm_filter"],
            "consultation": {"mode": "batch"},
        },
    )
    log.daemon("started", trigger_mode=os.environ.get("OPENCEPH_TRIGGER_MODE", "self"),
               feeds=load_feeds(), topics=load_topics(),
               use_llm=os.environ.get("USE_LLM_FILTER", "true"))

    signal.signal(signal.SIGTERM, lambda *_: (SHUTDOWN.set(), RUN_NOW.set()))
    signal.signal(signal.SIGINT, lambda *_: (SHUTDOWN.set(), RUN_NOW.set()))

    @ipc.on_directive
    def handle_directive(action: str, params: dict):
        if action == "pause": PAUSED.set()
        elif action == "resume": PAUSED.clear(); RUN_NOW.set()
        elif action == "kill": SHUTDOWN.set(); RUN_NOW.set()
        elif action in ("run_now", "set_self_schedule", "flush_pending"): RUN_NOW.set()

    @ipc.on_consultation_reply
    def handle_reply(consultation_id, message, actions_taken, should_continue, client_request_id):
        log.consultation("reply_received", consultation_id=consultation_id,
                         client_request_id=client_request_id,
                         should_continue=should_continue)
        items = CONSULTATION_CONTEXT.get(client_request_id, [])
        if not should_continue:
            CONSULTATION_CONTEXT.pop(client_request_id, None)
            log.consultation("ended_by_brain", consultation_id=consultation_id)
            return
        # If Brain's reply is not a question but a long analysis, just acknowledge
        has_question = "？" in message or "?" in message
        if not has_question and len(message) > 500:
            log.consultation("answer_sent", consultation_id=consultation_id, answer_length=18)
            ipc.consultation_message(consultation_id, "Feedback received. Waiting for next report.")
            return
        # Layer 3: Answer Brain's follow-up using AgentLoop
        items_summary = "\n".join(f"- {i.get('title', '')}: {i.get('reason', '')}" for i in items[:5])
        prompt = CONSULTATION_ANSWER_PROMPT.format(
            tentacle_name=config.tentacle_id,
            brain_question=message,
            items_summary=items_summary,
        )
        try:
            tools_path = Path(config.tentacle_dir) / "tools" / "tools.json"
            if tools_path.exists():
                tools = load_tools(str(tools_path))
                agent = AgentLoop(system_prompt=prompt, tools=tools, ipc=ipc, llm=llm)
                result = agent.run(message)
                answer = result.content
            else:
                response = llm.chat([
                    {"role": "system", "content": prompt},
                    {"role": "user", "content": message},
                ], temperature=0.3)
                answer = response.content or "No additional details available."
        except Exception as e:
            log.error("consultation_answer_failed", error=str(e))
            answer = f"Error querying information:{str(e)[:200]}"
        # BUG4 fix: empty reply fallback — guide Brain back to push decision
        if not answer or len(answer.strip()) < 10:
            answer = "Unable to retrieve more details. Please decide whether to push to the user based on the existing information in the report."
        log.consultation("answer_sent", consultation_id=consultation_id,
                         answer_length=len(answer))
        ipc.consultation_message(consultation_id, answer)

    @ipc.on_consultation_close
    def handle_close(consultation_id, summary, pushed_count, discarded_count, feedback, client_request_id):
        CONSULTATION_CONTEXT.pop(client_request_id, None)
        total = int(state.get_state("total_reports", "0") or "0") + 1
        state.set_state("total_reports", str(total))
        log.consultation("ended", consultation_id=consultation_id,
                         pushed=pushed_count, discarded=discarded_count)
        try:
            reports_dir = Path(config.tentacle_dir) / "reports" / "submitted"
            reports_dir.mkdir(parents=True, exist_ok=True)
            archive = {
                "consultation_id": consultation_id,
                "summary": summary,
                "pushed_count": pushed_count,
                "discarded_count": discarded_count,
                "feedback": feedback,
                "archived_at": datetime.now(timezone.utc).isoformat(),
            }
            fname = f"{datetime.now(timezone.utc).strftime('%Y-%m-%d')}-{consultation_id[:8]}.json"
            (reports_dir / fname).write_text(json.dumps(archive, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass
        update_status_md(config, state)

    # Main loop
    if os.environ.get("OPENCEPH_TRIGGER_MODE", "self") == "self":
        RUN_NOW.set()

    interval = int(os.environ.get("OPENCEPH_SELF_INTERVAL_SECONDS",
                                  os.environ.get("HN_INTERVAL_SECONDS", "7200")))

    while not SHUTDOWN.is_set():
        RUN_NOW.wait(timeout=interval)
        RUN_NOW.clear()
        if SHUTDOWN.is_set():
            break
        if PAUSED.is_set():
            continue

        try:
            findings, rejected_ids = run_daemon_cycle(state, log, llm, system_prompt)
            if findings:
                flush_pending(ipc, state, log, findings)
            ipc.status_update(
                status="idle",
                pending_items=len(PENDING),
                health="ok",
                stats={
                    "processed_total": state.get_processed_count(),
                    "pending_queue": len(PENDING),
                },
            )
            update_status_md(config, state)
        except Exception as e:
            log.error("cycle_error", error=str(e))

    log.daemon("stopped")
    ipc.close()


if __name__ == "__main__":
    import sys
    if "--dry-run" in sys.argv:
        config = TentacleConfig()
        print(f"Tentacle ID: {config.tentacle_id}")
        print(f"Topics: {load_topics()}")
        print(f"Feeds: {load_feeds()}")
        print(f"LLM Filter: {os.environ.get('USE_LLM_FILTER', 'true')}")
        print(f"Gateway URL: {os.environ.get('OPENCEPH_LLM_GATEWAY_URL', 'not set')}")
        sys.exit(0)
    main()
