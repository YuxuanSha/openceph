#!/usr/bin/env python3
"""
GitHub Issue Radar — skill_tentacle for OpenCeph

Monitors specified GitHub repositories for new issues and PRs, classifies them
using OpenRouter LLM reasoning, deduplicates via SQLite, and reports to Brain.
"""

import argparse
import logging
import os
import signal
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

# Allow importing sibling modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from github_client import GitHubClient
from evaluator import IssueEvaluator
from db import IssueDatabase
from ipc_client import IpcClient

logging.basicConfig(
    level=logging.INFO,
    format="[%(asctime)s] %(name)s %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("github-issue-radar")

TENTACLE_DIR = Path(__file__).parent.parent


# ── .env loader ─────────────────────────────────────────────────────────────

def _load_dotenv():
    """Manually parse a .env file next to the tentacle root, if present."""
    env_file = TENTACLE_DIR / ".env"
    if not env_file.exists():
        return
    with env_file.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


_load_dotenv()


# ── Configuration ────────────────────────────────────────────────────────────

GITHUB_TOKEN: str = os.environ.get("GITHUB_TOKEN", "")
OPENROUTER_API_KEY: str = os.environ.get("OPENROUTER_API_KEY", "")
WATCHED_REPOS: list[str] = [
    r.strip()
    for r in os.environ.get("WATCHED_REPOS", "").split(",")
    if r.strip()
]
FOCUS_AREAS: str = os.environ.get("FOCUS_AREAS", "general software engineering")
POLL_INTERVAL_MINUTES: int = int(os.environ.get("POLL_INTERVAL_MINUTES", "30"))

SOCKET_PATH: str = os.environ.get("OPENCEPH_SOCKET_PATH", "")
TENTACLE_ID: str = os.environ.get("OPENCEPH_TENTACLE_ID", "github-issue-radar")
TRIGGER_MODE: str = os.environ.get("OPENCEPH_TRIGGER_MODE", "self")

# SQLite DB path — stored in tentacle dir so it persists across restarts
DB_PATH: str = str(TENTACLE_DIR / "seen_issues.db")

# Batch accumulation config
BATCH_THRESHOLD = 3          # send batch when this many items accumulated
BATCH_MAX_AGE_HOURS = 24     # send batch after this many hours regardless


# ── Main Controller ──────────────────────────────────────────────────────────

class Radar:
    def __init__(self, dry_run: bool = False):
        self.dry_run = dry_run
        self.ipc: Optional[IpcClient] = None
        self.paused = False
        self.running = True

        self.gh = GitHubClient(GITHUB_TOKEN)
        self.evaluator = IssueEvaluator(OPENROUTER_API_KEY)
        self.db = IssueDatabase(DB_PATH)

        # Batch accumulation state
        self._batch_items: list[dict] = []
        self._batch_start: Optional[datetime] = None

    # ── Setup ────────────────────────────────────────────────────────────────

    def setup(self):
        self.db.init()
        if not self.dry_run:
            self._setup_ipc()

    def _setup_ipc(self):
        if not SOCKET_PATH:
            log.error("OPENCEPH_SOCKET_PATH not set. Use --dry-run for testing.")
            sys.exit(1)

        self.ipc = IpcClient(SOCKET_PATH, TENTACLE_ID)
        self.ipc.connect()
        self.ipc.on_directive(self.handle_directive)
        self.ipc.register(
            purpose=(
                "Monitor GitHub repos for new issues/PRs, classify with LLM, "
                "and report relevant findings"
            ),
            runtime="python",
        )
        log.info(f"Registered as tentacle: {TENTACLE_ID}")

    # ── Directive handling (Contract 3) ──────────────────────────────────────

    def handle_directive(self, payload: dict):
        action = payload.get("action", "")
        log.info(f"Received directive: {action}")

        if action == "pause":
            self.paused = True
            log.info("Paused.")
        elif action == "resume":
            self.paused = False
            log.info("Resumed.")
        elif action == "kill":
            log.info("Kill directive received. Shutting down.")
            self.running = False
        elif action == "run_now":
            log.info("run_now directive received. Executing immediate cycle.")
            self.run_cycle()
        else:
            log.warning(f"Unknown directive action: {action}")

    # ── Cycle execution ──────────────────────────────────────────────────────

    def run_cycle(self):
        if self.paused:
            log.info("Skipping cycle (paused).")
            return

        log.info(f"Starting cycle. Monitoring {len(WATCHED_REPOS)} repo(s).")
        poll_minutes = POLL_INTERVAL_MINUTES * 2  # look back 2x the interval for safety

        # 1. Fetch issues from GitHub
        all_issues = self.gh.get_issues(WATCHED_REPOS, since_minutes=poll_minutes)
        log.info(f"Fetched {len(all_issues)} total item(s) from GitHub.")

        # 2. Filter already-seen issues
        new_issues = [i for i in all_issues if not self.db.is_seen(i["url"])]
        log.info(f"{len(new_issues)} new (unseen) item(s) to classify.")

        if not new_issues:
            log.info("No new items. Staying silent.")
            self._maybe_flush_batch()
            return

        immediate_items: list[dict] = []

        # 3. Classify each new issue
        for issue in new_issues:
            log.info(f"  Classifying: [{issue['type']}] {issue['repo']} — {issue['title'][:60]}")

            classification = self.evaluator.classify(issue, FOCUS_AREAS)
            relevance = classification["relevance"]
            urgency = classification["urgency"]
            log.info(f"    → relevance={relevance}, urgency={urgency}")

            # 4. Store to DB regardless of outcome
            self.db.mark_seen(issue["url"], issue["title"], relevance)

            if relevance == "discard" or urgency == "discard":
                log.info("    → Discarded.")
                continue

            enriched = {
                "repo": issue["repo"],
                "type": issue["type"],
                "title": issue["title"],
                "url": issue["url"],
                "labels": issue["labels"],
                "author": issue["author"],
                "relevance": relevance,
                "category": classification["category"],
                "urgency": urgency,
                "summary": classification["summary"],
            }

            # 5. Apply report strategy
            if urgency == "immediate":
                immediate_items.append(enriched)
            else:
                self._batch_items.append(enriched)
                if self._batch_start is None:
                    self._batch_start = datetime.now(timezone.utc)

        # Send immediate items now
        if immediate_items:
            self._send_report(immediate_items, mode="immediate")

        # Maybe flush accumulated batch
        self._maybe_flush_batch()

    def _maybe_flush_batch(self):
        """Send the accumulated batch if threshold or age conditions are met."""
        if not self._batch_items:
            return

        age_hours = 0.0
        if self._batch_start:
            age_hours = (
                datetime.now(timezone.utc) - self._batch_start
            ).total_seconds() / 3600

        should_flush = (
            len(self._batch_items) >= BATCH_THRESHOLD
            or age_hours >= BATCH_MAX_AGE_HOURS
        )

        if should_flush:
            self._send_report(self._batch_items, mode="batch")
            self._batch_items = []
            self._batch_start = None

    def _send_report(self, items: list[dict], mode: str):
        """Send a consultation_request to the Brain (Contract 2)."""
        if not items:
            return

        repo_set = {item["repo"] for item in items}
        summary = (
            f"Found {len(items)} relevant item(s) across {len(repo_set)} repo(s) "
            f"[mode={mode}]"
        )
        log.info(f"Reporting: {summary}")

        if self.dry_run:
            log.info(f"[DRY RUN] Would send consultation_request (mode={mode}):")
            for item in items:
                log.info(
                    f"  [{item['urgency'].upper()}] [{item['category']}] "
                    f"{item['repo']} — {item['title']} — {item['url']}"
                )
                log.info(f"    summary: {item['summary']}")
            return

        if self.ipc:
            self.ipc.consultation_request(
                mode=mode,
                items=items,
                summary=summary,
            )
            for item in items:
                self.db.mark_notified(item["url"])
            log.info("Consultation request sent.")

    # ── Run loops ────────────────────────────────────────────────────────────

    def run_self_trigger(self):
        interval_seconds = POLL_INTERVAL_MINUTES * 60
        log.info(
            f"Running in self-trigger mode. Interval: {POLL_INTERVAL_MINUTES} min "
            f"({interval_seconds}s)"
        )
        while self.running:
            self.run_cycle()
            elapsed = 0
            while elapsed < interval_seconds and self.running:
                time.sleep(min(1, interval_seconds - elapsed))
                elapsed += 1

    def run_external_trigger(self):
        log.info("Running in external-trigger mode. Waiting for directives...")
        while self.running:
            time.sleep(1)

    def run(self):
        self.setup()
        try:
            if TRIGGER_MODE == "external":
                self.run_external_trigger()
            else:
                self.run_self_trigger()
        finally:
            log.info("Shutting down.")
            if self.ipc:
                self.ipc.close()
            self.db.close()


# ── Entry point ──────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="GitHub Issue Radar — OpenCeph Tentacle")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Test GitHub API + OpenRouter connectivity. "
            "Print results to stdout and exit without IPC connection."
        ),
    )
    args = parser.parse_args()

    # Validate required configuration
    if not GITHUB_TOKEN:
        log.error("GITHUB_TOKEN not set. Cannot access GitHub API.")
        if not args.dry_run:
            sys.exit(1)
        else:
            log.warning("[DRY RUN] Continuing without token (public repos only).")

    if not OPENROUTER_API_KEY:
        log.error("OPENROUTER_API_KEY not set. Cannot classify issues.")
        if not args.dry_run:
            sys.exit(1)
        else:
            log.warning("[DRY RUN] Classification will fail gracefully.")

    if not WATCHED_REPOS:
        log.error("WATCHED_REPOS not set. No repositories to monitor.")
        sys.exit(1)

    log.info(f"Monitoring repos: {', '.join(WATCHED_REPOS)}")
    log.info(f"Focus areas: {FOCUS_AREAS}")
    log.info(f"Poll interval: {POLL_INTERVAL_MINUTES} min")
    log.info(f"Trigger mode: {TRIGGER_MODE}")
    log.info(f"DB path: {DB_PATH}")

    if args.dry_run:
        log.info("[DRY RUN] Running a single cycle and exiting.")
        radar = Radar(dry_run=True)
        radar.setup()
        radar.run_cycle()
        radar.db.close()
        log.info("[DRY RUN] Done.")
        return

    radar = Radar(dry_run=False)

    def shutdown_handler(signum, frame):
        log.info(f"Signal {signum} received. Shutting down gracefully.")
        radar.running = False

    signal.signal(signal.SIGTERM, shutdown_handler)
    signal.signal(signal.SIGINT, shutdown_handler)

    try:
        radar.run()
    except KeyboardInterrupt:
        log.info("Interrupted. Exiting.")
    finally:
        if radar.ipc:
            radar.ipc.close()
        radar.db.close()


if __name__ == "__main__":
    main()
