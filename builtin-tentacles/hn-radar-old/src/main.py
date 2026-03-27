#!/usr/bin/env python3
"""
hn-radar — OpenCeph skill_tentacle
Monitor Hacker News posts and report relevant items.
"""

import os
import sys
import signal
import threading
import time
import json
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(str(Path(__file__).resolve().parents[1]))

from openceph_runtime import (
    IpcClient, LlmClient, TentacleLogger, TentacleConfig, StateDB,
)

from hn_fetcher import fetch_latest_items
from filter_engine import filter_items, load_topics, to_consultation_items

# ─── Config ───
config = TentacleConfig()
log = TentacleLogger()

# ─── Global state ───
_shutdown = threading.Event()
_paused = threading.Event()
_run_now = threading.Event()

signal.signal(signal.SIGTERM, lambda *_: (_shutdown.set(), _run_now.set()))
signal.signal(signal.SIGINT, lambda *_: (_shutdown.set(), _run_now.set()))


# ─── IPC ───
ipc = IpcClient()

@ipc.on_directive
def handle_directive(action, params):
    if action == "pause": _paused.set()
    elif action == "resume": _paused.clear(); _run_now.set()
    elif action == "kill": _shutdown.set(); _run_now.set()
    elif action in ("run_now", "set_self_schedule"): _run_now.set()

@ipc.on_consultation_reply
def handle_consultation_reply(consultation_id, message, actions_taken, should_continue):
    if not should_continue:
        log.consultation("ended", consultation_id=consultation_id)
        return
    # Brain asked a follow-up — use LLM to answer
    llm = LlmClient()
    response = llm.chat([
        {"role": "user", "content": message},
    ], temperature=0.3)
    ipc.consultation_message(consultation_id, response.content or "No additional details available.")


# ─── Layer 1: Engineering (no LLM tokens) ───

def fetch_new_data() -> list[dict]:
    """Fetch latest HN items across all topics."""
    topics = load_topics()
    return fetch_latest_items(topics)

def rule_filter(items: list[dict], db: StateDB) -> list[dict]:
    """Rule-based filtering: dedup + score/comments thresholds."""
    topics = load_topics()
    min_score = int(os.environ.get("HN_MIN_SCORE", "50"))
    min_comments = int(os.environ.get("HN_MIN_COMMENTS", "20"))

    fresh = [item for item in items if not db.is_processed(f"hn:{item['id']}")]
    for item in fresh:
        db.mark_processed(f"hn:{item['id']}")

    filtered = filter_items(fresh, topics, min_score, min_comments)
    return to_consultation_items(filtered[:10])


# ─── Layer 2: Agent (LLM filtering, optional) ───

def activate_agent(pending_items: list[dict]) -> list[dict]:
    """Optional LLM filtering for higher quality."""
    use_llm = os.environ.get("USE_LLM_FILTER", "false").lower() == "true"
    if not use_llm:
        return pending_items

    llm = LlmClient()
    criteria = os.environ.get("LLM_FILTER_CRITERIA", "Prioritize concrete engineering lessons and non-trivial technical insights.")
    accepted = []
    for item in pending_items:
        try:
            response = llm.chat([
                {"role": "user", "content": f"Decide if this HN post is worth pushing. Criteria: {criteria}\n\nTitle & content:\n{item['content']}\n\nRespond JSON: {{\"accept\": true|false}}"}
            ], temperature=0.1, max_tokens=80)
            text = response.content or ""
            if '"accept": true' in text or '"accept":true' in text:
                accepted.append(item)
            log.agent("llm_filter", item_id=item["id"], accepted=True)
        except Exception as e:
            accepted.append(item)  # On error, include item
            log.agent("llm_filter_error", item_id=item["id"], error=str(e))
    return accepted


# ─── Layer 3: Consultation ───

def format_consultation_report(items: list[dict]) -> str:
    lines = [f"扫描 Hacker News，发现 {len(items)} 条值得关注：\n"]
    for i, item in enumerate(items, 1):
        lines.append(f"{i}. {item['content']}\n")
    return "\n".join(lines)


def update_status_md(db: StateDB, pending_count: int):
    workspace = Path(os.environ.get("OPENCEPH_TENTACLE_WORKSPACE", "workspace"))
    if not workspace.exists():
        return
    status_path = workspace / "STATUS.md"
    total = db.get_stat("total_scanned")
    reported = db.get_stat("total_reported")
    status_path.write_text(
        f"# HN Radar — 运行状态\n\n"
        f"## 当前状态\n"
        f"- **运行状态：** 正常运行中\n"
        f"- **上次执行：** {time.strftime('%Y-%m-%d %H:%M UTC')}\n"
        f"- **待汇报队列：** {pending_count} 条\n\n"
        f"## 统计\n"
        f"- 扫描总数：{int(total)}\n"
        f"- 汇报总数：{int(reported)}\n"
    )


# ─── Main loop ───

def main():
    db = StateDB()
    pending: list[dict] = []
    batch_size = int(os.environ.get("BATCH_SIZE", "3"))

    ipc.connect()
    ipc.register(purpose="Monitor Hacker News and report relevant items.", runtime="python")
    log.daemon("started", trigger_mode=config.trigger_mode)

    if os.environ.get("OPENCEPH_TRIGGER_MODE", "self") == "self":
        _run_now.set()

    interval = int(os.environ.get("HN_INTERVAL_SECONDS", os.environ.get("OPENCEPH_SELF_INTERVAL_SECONDS", "7200")))

    while not _shutdown.is_set():
        _run_now.wait(timeout=interval)
        _run_now.clear()
        if _shutdown.is_set():
            break
        if _paused.is_set():
            continue

        try:
            # Layer 1: Fetch + rule filter
            raw = fetch_new_data()
            filtered = rule_filter(raw, db)
            db.increment_stat("total_scanned", len(raw))

            log.daemon("cycle_complete", scanned=len(raw), filtered=len(filtered), pending=len(pending))

            # Layer 2: Optional LLM filter
            if filtered:
                filtered = activate_agent(filtered)

            pending.extend(filtered)

            # Layer 3: Consultation when batch threshold met
            if len(pending) >= batch_size:
                log.consultation("starting", item_count=len(pending))
                ipc.consultation_request(
                    mode="batch",
                    summary=f"[HN Radar] 发现 {len(pending)} 条值得关注的帖子",
                    initial_message=format_consultation_report(pending),
                    item_count=len(pending),
                    context={"topics": load_topics(), "total_scanned": int(db.get_stat("total_scanned"))},
                )
                db.increment_stat("total_reported", len(pending))
                pending = []

            # Update status
            ipc.status_update(status="idle", pending_items=len(pending), health="ok")
            update_status_md(db, len(pending))

        except Exception as e:
            log.daemon("error", error=str(e))

    ipc.close()
    log.daemon("stopped")


if __name__ == "__main__":
    if "--dry-run" in sys.argv:
        print("✓ 配置正确")
        print(f"✓ LLM Gateway: {os.environ.get('OPENCEPH_LLM_GATEWAY_URL')}")
        print(f"✓ Tentacle ID: {os.environ.get('OPENCEPH_TENTACLE_ID')}")
        print(f"✓ Topics: {load_topics()}")
        sys.exit(0)
    main()
