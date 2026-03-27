#!/usr/bin/env python3
"""
HN Engineering Digest — OpenCeph skill_tentacle

Fetch HN top stories, score with LLM, deduplicate via SQLite,
and report to brain following the tiered reporting strategy.

Three-layer architecture:
  Layer 1 (Engineering): HN fetch + pre-filter + dedup (no LLM tokens)
  Layer 2 (Agent): LLM-based quality scoring
  Layer 3 (Consultation): Tiered reporting to brain
"""

import os
import sys
import signal
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(str(Path(__file__).resolve().parents[1]))

from openceph_runtime import (
    IpcClient, LlmClient, TentacleLogger, TentacleConfig, StateDB,
)

# ─── Config ───
config = TentacleConfig()
log = TentacleLogger()

TENTACLE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_INTERVAL_SECONDS = 6 * 3600  # 6 hours

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
    if action == "pause":
        _paused.set()
    elif action == "resume":
        _paused.clear(); _run_now.set()
    elif action == "kill":
        _shutdown.set(); _run_now.set()
    elif action in ("run_now", "set_self_schedule"):
        _run_now.set()
    elif action == "set_trigger_mode":
        # Allow runtime trigger mode change
        pass

@ipc.on_consultation_reply
def handle_consultation_reply(consultation_id, message, actions_taken, should_continue):
    if not should_continue:
        log.consultation("ended", consultation_id=consultation_id)
        return
    llm = LlmClient()
    response = llm.chat([
        {"role": "user", "content": message},
    ], temperature=0.3)
    ipc.consultation_message(consultation_id, response.content or "No additional details available.")


# ─── Interval parser ───

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


# ─── Layer 2: Agent (LLM scoring) ───
# QualityScorer uses LlmClient instead of direct requests.post()

class QualityScorerV2:
    """Wrapper around the existing QualityScorer that uses LlmClient for LLM calls."""

    _SCORE_SCHEMA = """\
Respond with a JSON object (no markdown, no explanation) with exactly these keys:
{
  "quality_score": <float 0.0-1.0>,
  "engineering_relevance": <"high" | "medium" | "low">,
  "topics": [<string>, ...],
  "summary": "<one-sentence summary of the engineering content>"
}

Scoring guide:
- 0.9-1.0  Outstanding: novel technique, in-depth architecture, production case study with numbers
- 0.7-0.89 Good: solid technical content, worth reading for an engineer in this area
- 0.5-0.69 Marginal: some technical value but shallow, introductory, or off-topic
- 0.0-0.49 Poor: opinion, news, non-technical, marketing
"""

    def __init__(self):
        self._llm = LlmClient()

    def score(self, story: dict, engineering_criteria: str) -> dict:
        prompt = self._build_prompt(story, engineering_criteria)
        try:
            response = self._llm.chat(
                [{"role": "user", "content": prompt}],
                temperature=0.1,
                max_tokens=256,
            )
            import json
            content = (response.content or "").strip()
            result = json.loads(content)
            return self._validate(result)
        except Exception as exc:
            log.agent("score_error", story_id=story.get("objectID"), error=str(exc))
            return self._fallback(story)

    def _build_prompt(self, story: dict, engineering_criteria: str) -> str:
        title = story.get("title", "")
        url = story.get("url", "")
        hn_points = story.get("score", 0)
        num_comments = story.get("num_comments", 0)

        return (
            f"You are evaluating a Hacker News story for engineering quality.\n\n"
            f"Engineering criteria the user cares about:\n{engineering_criteria}\n\n"
            f"Story details:\n"
            f"  Title: {title}\n"
            f"  URL: {url}\n"
            f"  HN points: {hn_points}\n"
            f"  Comments: {num_comments}\n\n"
            f"{self._SCORE_SCHEMA}"
        )

    def _validate(self, result: dict) -> dict:
        quality_score = float(result.get("quality_score", 0.0))
        quality_score = max(0.0, min(1.0, quality_score))
        engineering_relevance = result.get("engineering_relevance", "low")
        if engineering_relevance not in ("high", "medium", "low"):
            engineering_relevance = "low"
        topics = result.get("topics", [])
        if not isinstance(topics, list):
            topics = []
        topics = [str(t) for t in topics]
        summary = str(result.get("summary", ""))
        return {
            "quality_score": quality_score,
            "engineering_relevance": engineering_relevance,
            "topics": topics,
            "summary": summary,
        }

    def _fallback(self, story: dict) -> dict:
        return {
            "quality_score": 0.0,
            "engineering_relevance": "low",
            "topics": [],
            "summary": f"Scoring unavailable for: {story.get('title', '')}",
        }


# ─── Digest Runner ───

class DigestRunner:
    """
    Main loop: fetch -> dedup -> score -> report via IPC.

    Tiered reporting strategy:
      quality_score > 0.9  -> send immediately
      quality_score > 0.6  -> batch; send when >=3 accumulated or 24h elapsed
      quality_score <= 0.6 -> discard
      day boundary         -> flush pending batch (guarantee >=1 report/day)
    """

    IMMEDIATE_THRESHOLD = 0.9
    BATCH_THRESHOLD = 0.6
    BATCH_SIZE = 3
    DAY_SECONDS = 86400

    def __init__(
        self,
        hn_client,
        scorer,
        db,
        stats_db: StateDB,
        trigger_mode: str,
        interval: int,
        engineering_criteria: str,
    ):
        self.hn_client = hn_client
        self.scorer = scorer
        self.db = db
        self.stats_db = stats_db
        self.trigger_mode = trigger_mode
        self.interval = interval
        self.engineering_criteria = engineering_criteria

        self._pending_batch: list[dict] = []
        self._last_report_time: float = time.time()

    # ── Single cycle ──

    def run_once(self, reason: str = "scheduled"):
        log.daemon("cycle_start", reason=reason, trigger_mode=self.trigger_mode)

        raw_stories = self.hn_client.fetch_top_stories()
        candidates = self.hn_client.filter_stories(raw_stories)
        log.daemon("fetch_complete", fetched=len(raw_stories), candidates=len(candidates))

        self.stats_db.increment_stat("total_scanned", len(raw_stories))

        for story in candidates:
            story_id = story["objectID"]

            if self.db.is_seen(story_id):
                continue

            # Layer 2: LLM scoring
            score_result = self.scorer.score(story, self.engineering_criteria)
            quality = score_result["quality_score"]

            self.db.mark_seen(
                story_id=story_id,
                title=story["title"],
                url=story["url"],
                quality_score=quality,
            )

            log.agent(
                "scored",
                story_id=story_id,
                quality=f"{quality:.2f}",
                relevance=score_result["engineering_relevance"],
                title=story["title"][:60],
            )

            if quality <= self.BATCH_THRESHOLD:
                continue

            item = self._build_item(story, score_result)

            # Layer 3: Consultation — tiered reporting
            if quality > self.IMMEDIATE_THRESHOLD:
                log.consultation("immediate", story_id=story_id)
                self._send_report(
                    items=[item],
                    summary=f"Outstanding engineering post: {story['title']}",
                    mode="immediate",
                )
                self.db.mark_notified(story_id)
                self.stats_db.increment_stat("total_reported", 1)
            else:
                self._pending_batch.append(item)
                if len(self._pending_batch) >= self.BATCH_SIZE:
                    self._flush_batch(reason="batch_full")

        # Day-boundary guarantee
        elapsed = time.time() - self._last_report_time
        if elapsed >= self.DAY_SECONDS:
            if self._pending_batch:
                self._flush_batch(reason="day_boundary")
            else:
                self._send_report(
                    items=[],
                    summary="No notable engineering content in the past 24 hours.",
                    mode="batch",
                )
                self._last_report_time = time.time()

        ipc.status_update(
            status="idle",
            pending_items=len(self._pending_batch),
            health="ok",
        )
        update_status_md(self.stats_db, len(self._pending_batch))

        log.daemon(
            "cycle_complete",
            scanned=len(raw_stories),
            candidates=len(candidates),
            pending=len(self._pending_batch),
        )

    def _flush_batch(self, reason: str = "flush"):
        if not self._pending_batch:
            return
        count = len(self._pending_batch)
        summary = self._build_batch_summary(self._pending_batch)
        log.consultation("batch_flush", item_count=count, reason=reason)
        self._send_report(items=list(self._pending_batch), summary=summary, mode="batch")
        for item in self._pending_batch:
            self.db.mark_notified(item["id"])
        self.stats_db.increment_stat("total_reported", count)
        self._pending_batch.clear()
        self._last_report_time = time.time()

    def _send_report(self, items: list[dict], summary: str, mode: str):
        report_text = self._format_report(items) if items else summary
        ipc.consultation_request(
            mode=mode,
            summary=summary,
            initial_message=report_text,
            item_count=len(items),
            context={
                "total_scanned": int(self.stats_db.get_stat("total_scanned")),
                "total_reported": int(self.stats_db.get_stat("total_reported")),
            },
        )

    # ── Main loop ──

    def loop(self):
        if self.trigger_mode == "self":
            self.run_once(reason="startup")

        while not _shutdown.is_set():
            if self.trigger_mode == "self" and not _paused.is_set():
                _run_now.wait(timeout=self.interval)
                _run_now.clear()
                if _shutdown.is_set():
                    break
                if not _paused.is_set():
                    self.run_once(reason="self_schedule")
            else:
                _run_now.wait(timeout=1)
                _run_now.clear()
                if _shutdown.is_set():
                    break
                if not _paused.is_set():
                    self.run_once(reason="directive")

    # ── Helpers ──

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
        all_topics: list[str] = []
        for item in items:
            all_topics.extend(item.get("topics", []))
        unique_topics = list(dict.fromkeys(all_topics))[:6]
        topic_str = ", ".join(unique_topics) if unique_topics else "various topics"
        return f"{len(items)} engineering post(s) on {topic_str}."

    @staticmethod
    def _format_report(items: list[dict]) -> str:
        lines = [f"HN Engineering Digest: {len(items)} 条值得关注的工程内容\n"]
        for i, item in enumerate(items, 1):
            lines.append(
                f"{i}. [{item.get('engineering_relevance', '?')}] {item.get('title', '')}\n"
                f"   质量分: {item.get('quality_score', 0):.2f} | "
                f"HN: {item.get('score', 0)} pts, {item.get('num_comments', 0)} comments\n"
                f"   {item.get('summary', '')}\n"
                f"   {item.get('url', '')}\n"
            )
        return "\n".join(lines)


# ─── STATUS.md self-maintenance ───

def update_status_md(stats_db: StateDB, pending_count: int):
    workspace = Path(os.environ.get("OPENCEPH_TENTACLE_WORKSPACE", "workspace"))
    if not workspace.exists():
        return
    status_path = workspace / "STATUS.md"
    total_scanned = stats_db.get_stat("total_scanned")
    total_reported = stats_db.get_stat("total_reported")
    status_path.write_text(
        f"# HN Engineering Digest — 运行状态\n\n"
        f"## 当前状态\n"
        f"- **运行状态：** 正常运行中\n"
        f"- **上次执行：** {time.strftime('%Y-%m-%d %H:%M UTC')}\n"
        f"- **待汇报队列：** {pending_count} 条\n\n"
        f"## 统计\n"
        f"- 扫描总数：{int(total_scanned)}\n"
        f"- 汇报总数：{int(total_reported)}\n"
    )


# ─── Dry run ───

def dry_run(hn_client, scorer, engineering_criteria: str):
    log.daemon("dry_run_start")
    raw = hn_client.fetch_top_stories()
    candidates = hn_client.filter_stories(raw)
    print(f"Fetched {len(raw)} stories, {len(candidates)} pass pre-filter")

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


# ─── Entry ───

def main():
    # Environment
    trigger_mode = os.environ.get("OPENCEPH_TRIGGER_MODE", "self")
    state_dir = os.environ.get("OPENCEPH_RUNTIME_DIR") or os.environ.get("OPENCEPH_TENTACLE_DIR") or str(TENTACLE_DIR)
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
    from db import StoryDatabase

    hn_client = HNClient(
        min_score=0,
        min_comments=min_comments,
        topics=topics,
    )

    scorer = QualityScorerV2()

    if is_dry_run:
        dry_run(hn_client, scorer, engineering_criteria)
        print("✓ 配置正确")
        return

    db_path = str(Path(state_dir) / "hn_digest.db")
    db = StoryDatabase(db_path=db_path)
    db.init()

    stats_db = StateDB()

    ipc.connect()
    ipc.register(
        purpose="Fetch HN top stories, score engineering relevance with LLM, and report outstanding content",
        runtime="python",
    )
    log.daemon("started", trigger_mode=trigger_mode)

    runner = DigestRunner(
        hn_client=hn_client,
        scorer=scorer,
        db=db,
        stats_db=stats_db,
        trigger_mode=trigger_mode,
        interval=interval,
        engineering_criteria=engineering_criteria,
    )

    try:
        runner.loop()
    except KeyboardInterrupt:
        log.daemon("interrupted")
    finally:
        db.close()
        ipc.close()
        log.daemon("stopped")


if __name__ == "__main__":
    if "--dry-run" in sys.argv:
        main()
    else:
        main()
