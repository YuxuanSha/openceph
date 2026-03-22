#!/usr/bin/env python3
"""
HN Engineering Digest — skill_tentacle entry point.

Fetch HN top stories, score with LLM, deduplicate via SQLite,
and report to brain following the tiered reporting strategy.

IPC three-contract protocol:
  1. tentacle_register on startup
  2. consultation_request for reporting
  3. Directive handling (pause/resume/kill/run_now)
"""

import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s %(message)s",
)
log = logging.getLogger("hn-digest")

# Resolve the directory containing this file so we can locate prompt/SYSTEM.md
TENTACLE_DIR = Path(__file__).resolve().parent.parent

DEFAULT_INTERVAL_SECONDS = 6 * 3600  # 6 hours


# ── Interval parser ─────────────────────────────────────────────────────────

def parse_interval(value: str) -> int:
    """Parse a human-readable interval string to seconds."""
    raw = (value or "").strip().lower()
    if not raw:
        return DEFAULT_INTERVAL_SECONDS
    if raw.endswith("ms"):
        return max(1, int(raw[:-2]) // 1000)
    if raw.endswith("s"):
        return max(1, int(raw[:-1]))
    if raw.endswith("m"):
        return max(1, int(raw[:-1]) * 60)
    if raw.endswith("h"):
        return max(1, int(raw[:-1]) * 3600)
    if raw.endswith("d"):
        return max(1, int(raw[:-1]) * 86400)
    return DEFAULT_INTERVAL_SECONDS


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Digest Runner ────────────────────────────────────────────────────────────

class DigestRunner:
    """
    Main loop: fetch → dedup → score → report via IPC.

    Tiered reporting strategy:
      quality_score > 0.9  → send immediately
      quality_score > 0.6  → batch; send when >=3 accumulated or 24h elapsed
      quality_score <= 0.6 → discard
      day boundary         → flush pending batch (guarantee ≥1 report/day)
    """

    IMMEDIATE_THRESHOLD = 0.9
    BATCH_THRESHOLD = 0.6
    BATCH_SIZE = 3
    DAY_SECONDS = 86400

    def __init__(
        self,
        ipc,
        hn_client,
        scorer,
        db,
        trigger_mode: str,
        interval: int,
        engineering_criteria: str,
    ):
        self.ipc = ipc
        self.hn_client = hn_client
        self.scorer = scorer
        self.db = db
        self.trigger_mode = trigger_mode
        self.interval = interval
        self.engineering_criteria = engineering_criteria

        self.paused = False
        self.stop_requested = False

        self._pending_batch: list[dict] = []
        self._last_report_time: float = time.time()

    # ── Single cycle ─────────────────────────────────────────────────────────

    def run_once(self, reason: str = "scheduled"):
        log.info("Starting fetch cycle (reason=%s)", reason)

        raw_stories = self.hn_client.fetch_top_stories()
        candidates = self.hn_client.filter_stories(raw_stories)
        log.info("Fetched %d stories, %d pass pre-filter", len(raw_stories), len(candidates))

        for story in candidates:
            story_id = story["objectID"]

            if self.db.is_seen(story_id):
                log.debug("Skip seen story %s", story_id)
                continue

            score_result = self.scorer.score(story, self.engineering_criteria)
            quality = score_result["quality_score"]

            self.db.mark_seen(
                story_id=story_id,
                title=story["title"],
                url=story["url"],
                quality_score=quality,
            )

            log.info(
                "Scored story %s: quality=%.2f relevance=%s title=%r",
                story_id,
                quality,
                score_result["engineering_relevance"],
                story["title"][:60],
            )

            if quality <= self.BATCH_THRESHOLD:
                log.debug("Discard story %s (quality=%.2f)", story_id, quality)
                continue

            item = self._build_item(story, score_result)

            if quality > self.IMMEDIATE_THRESHOLD:
                log.info("Outstanding story — sending immediately: %s", story_id)
                self._send_report(
                    items=[item],
                    summary=f"Outstanding engineering post: {story['title']}",
                    mode="immediate",
                )
                self.db.mark_notified(story_id)
            else:
                self._pending_batch.append(item)
                log.info("Batched story %s (batch size=%d)", story_id, len(self._pending_batch))
                if len(self._pending_batch) >= self.BATCH_SIZE:
                    self._flush_batch(reason="batch_full")

        # Day-boundary guarantee
        elapsed = time.time() - self._last_report_time
        if elapsed >= self.DAY_SECONDS:
            if self._pending_batch:
                self._flush_batch(reason="day_boundary")
            else:
                log.info("Day boundary reached — no pending items, sending empty notification")
                self._send_report(items=[], summary="No notable engineering content in the past 24 hours.", mode="batch")
                self._last_report_time = time.time()

    def _flush_batch(self, reason: str = "flush"):
        if not self._pending_batch:
            return
        count = len(self._pending_batch)
        summary = self._build_batch_summary(self._pending_batch)
        log.info("Flushing batch (%d items, reason=%s)", count, reason)
        self._send_report(items=list(self._pending_batch), summary=summary, mode="batch")
        for item in self._pending_batch:
            self.db.mark_notified(item["id"])
        self._pending_batch.clear()
        self._last_report_time = time.time()

    def _send_report(self, items: list[dict], summary: str, mode: str):
        self.ipc.consultation_request(mode=mode, items=items, summary=summary)

    # ── Directive handler ────────────────────────────────────────────────────

    def handle_directive(self, payload: dict):
        action = payload.get("action", "")
        log.info("Received directive: %s", action)

        if action == "run_now":
            self.run_once(reason="directive_run_now")
        elif action == "pause":
            self.paused = True
            log.info("Paused")
        elif action == "resume":
            self.paused = False
            log.info("Resumed")
        elif action == "kill":
            log.info("Kill directive received — stopping")
            self.stop_requested = True
        elif action == "set_self_schedule":
            self.trigger_mode = "self"
            interval_str = payload.get("interval")
            if interval_str:
                self.interval = parse_interval(interval_str)
                log.info("Interval updated to %ds", self.interval)
        elif action == "set_trigger_mode":
            self.trigger_mode = payload.get("triggerMode", self.trigger_mode)
            log.info("Trigger mode changed to %s", self.trigger_mode)
        else:
            log.warning("Unknown directive: %s", action)

    # ── Main loop ────────────────────────────────────────────────────────────

    def loop(self):
        if self.trigger_mode == "self":
            self.run_once(reason="startup")

        while not self.stop_requested:
            if self.trigger_mode == "self" and not self.paused:
                time.sleep(self.interval)
                if self.stop_requested:
                    break
                if not self.paused:
                    self.run_once(reason="self_schedule")
            else:
                time.sleep(1)

    # ── Helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _build_item(story: dict, score_result: dict) -> dict:
        return {
            "id": story["objectID"],
            "title": story["title"],
            "url": story["url"],
            "hn_url": story["hn_url"],
            "score": story["score"],
            "num_comments": story["num_comments"],
            "quality_score": score_result["quality_score"],
            "engineering_relevance": score_result["engineering_relevance"],
            "topics": score_result["topics"],
            "summary": score_result["summary"],
        }

    @staticmethod
    def _build_batch_summary(items: list[dict]) -> str:
        if not items:
            return "No notable content."
        # Collect all topics for a brief overview
        all_topics: list[str] = []
        for item in items:
            all_topics.extend(item.get("topics", []))
        unique_topics = list(dict.fromkeys(all_topics))[:6]
        topic_str = ", ".join(unique_topics) if unique_topics else "various topics"
        return f"{len(items)} engineering post(s) on {topic_str}."


# ── Dry run ──────────────────────────────────────────────────────────────────

def dry_run(hn_client, scorer, engineering_criteria: str):
    log.info("=== DRY RUN MODE ===")
    raw = hn_client.fetch_top_stories()
    candidates = hn_client.filter_stories(raw)
    log.info("Fetched %d stories, %d pass pre-filter", len(raw), len(candidates))

    for i, story in enumerate(candidates, 1):
        result = scorer.score(story, engineering_criteria)
        print(
            f"\n[{i}] {story['title']}\n"
            f"    score={story['score']}  comments={story['num_comments']}\n"
            f"    quality={result['quality_score']:.2f}  relevance={result['engineering_relevance']}\n"
            f"    topics={result['topics']}\n"
            f"    summary={result['summary']}\n"
            f"    {story['hn_url']}"
        )

    if not candidates:
        print("\n(No stories passed the pre-filter)")
    print()


# ── Entry ────────────────────────────────────────────────────────────────────

def main():
    # Read system prompt (required by spec)
    SYSTEM_PROMPT = (TENTACLE_DIR / "prompt" / "SYSTEM.md").read_text()  # noqa: F841

    # Environment
    socket_path = os.environ.get("OPENCEPH_SOCKET_PATH", "")
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "t_hn_digest")
    trigger_mode = os.environ.get("OPENCEPH_TRIGGER_MODE", "self")
    state_dir = os.environ.get("OPENCEPH_STATE_PATH", ".")
    openrouter_api_key = os.environ.get("OPENROUTER_API_KEY", "")
    openrouter_model = os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini")
    min_comments = int(os.environ.get("MIN_COMMENTS", "100"))
    topics_raw = os.environ.get("WATCHED_TOPICS", "rust,go,ai,llm,infrastructure,database,systems,compilers,distributed")
    topics = [t.strip() for t in topics_raw.split(",") if t.strip()]
    engineering_criteria = os.environ.get(
        "ENGINEERING_CRITERIA",
        "Deep technical dives, architecture decisions, benchmarks, novel systems design, lessons learned from production",
    )
    interval = parse_interval(os.environ.get("FETCH_INTERVAL", "6h"))

    is_dry_run = "--dry-run" in sys.argv

    # Import local modules (same src/ directory)
    sys.path.insert(0, str(Path(__file__).parent))
    from hn_client import HNClient
    from quality_scorer import QualityScorer
    from db import StoryDatabase

    hn_client = HNClient(
        min_score=0,
        min_comments=min_comments,
        topics=topics,
    )

    if is_dry_run:
        if not openrouter_api_key:
            log.error("OPENROUTER_API_KEY is required even in dry-run mode")
            sys.exit(1)
        scorer = QualityScorer(api_key=openrouter_api_key, model=openrouter_model)
        dry_run(hn_client, scorer, engineering_criteria)
        return

    # Validate required env
    if not socket_path:
        log.error("OPENCEPH_SOCKET_PATH is not set — exiting")
        sys.exit(1)
    if not openrouter_api_key:
        log.error("OPENROUTER_API_KEY is not set — exiting")
        sys.exit(1)

    from ipc_client import IpcClient

    scorer = QualityScorer(api_key=openrouter_api_key, model=openrouter_model)

    db_path = str(Path(state_dir) / "hn_digest.db")
    db = StoryDatabase(db_path=db_path)
    db.init()

    ipc = IpcClient(socket_path=socket_path, tentacle_id=tentacle_id)
    ipc.connect()

    # Contract 1: register
    ipc.register(
        purpose="Fetch HN top stories, score engineering relevance with LLM, and report outstanding content",
        runtime="python",
    )

    runner = DigestRunner(
        ipc=ipc,
        hn_client=hn_client,
        scorer=scorer,
        db=db,
        trigger_mode=trigger_mode,
        interval=interval,
        engineering_criteria=engineering_criteria,
    )

    # Contract 3: register directive handler
    ipc.on_directive(runner.handle_directive)

    try:
        runner.loop()
    except KeyboardInterrupt:
        log.info("Interrupted by user")
    finally:
        db.close()
        ipc.close()
        log.info("Shutdown complete")


if __name__ == "__main__":
    main()
