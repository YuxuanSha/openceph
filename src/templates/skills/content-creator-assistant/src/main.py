"""
Content Creator Assistant — main entry point
Collects materials, analyzes topics, generates article drafts,
and publishes only after explicit user approval via action_confirm.

CRITICAL: Never auto-publish. Every publish requires action_approved directive.
"""

import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from analyzer import ContentAnalyzer
from article_writer import ArticleWriter
from feishu_bot import FeishuBot
from ipc_client import IpcClient
from material_db import MaterialDB
from publisher import Publisher

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("content-creator-assistant")

# ── Paths ──
TENTACLE_DIR = Path(__file__).parent.parent
SYSTEM_PROMPT = (TENTACLE_DIR / "prompt" / "SYSTEM.md").read_text()
DB_PATH = str(TENTACLE_DIR / "data" / "content.db")

# ── Environment ──
SOCKET_PATH = os.environ.get("OPENCEPH_SOCKET_PATH", os.environ.get("OPENCEPH_IPC_SOCKET", ""))
TENTACLE_ID = os.environ.get("OPENCEPH_TENTACLE_ID", "t_content_creator")
TRIGGER_MODE = os.environ.get("OPENCEPH_TRIGGER_MODE", "self")
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
FEISHU_APP_ID = os.environ.get("FEISHU_APP_ID", "")
FEISHU_APP_SECRET = os.environ.get("FEISHU_APP_SECRET", "")
PUBLISH_PLATFORM = os.environ.get("PUBLISH_PLATFORM", "feishu_doc")
COLLECT_INTERVAL = os.environ.get("COLLECT_INTERVAL", "24h")

# ── Runtime state ──
running = True
paused = False
# article_id -> article dict awaiting user approval
pending_approvals: dict[str, dict] = {}


def parse_interval(s: str) -> int:
    s = s.strip().lower()
    if s.endswith("h"):
        return int(s[:-1]) * 3600
    if s.endswith("m"):
        return int(s[:-1]) * 60
    if s.endswith("s"):
        return int(s[:-1])
    return int(s)


def is_monday() -> bool:
    return datetime.now(timezone.utc).weekday() == 0


# ── Directive handler ──

def handle_directive(
    payload: dict,
    client: IpcClient,
    db: MaterialDB,
    publisher: Publisher,
):
    global running, paused

    action = payload.get("action", "")
    log.info(f"Directive received: {action}")

    if action == "kill":
        running = False

    elif action == "pause":
        paused = True

    elif action == "resume":
        paused = False

    elif action == "run_now":
        paused = False
        # Flag for the main loop to trigger an immediate cycle
        # (handled via the _run_now_flag mechanism below)
        _set_run_now()

    elif action == "action_approved":
        article_id = payload.get("article_id", "")
        if not article_id:
            log.warning("action_approved received without article_id")
            return
        _handle_approved(article_id, client, db, publisher)

    elif action == "action_rejected":
        article_id = payload.get("article_id", "")
        if not article_id:
            log.warning("action_rejected received without article_id")
            return
        _handle_rejected(article_id, db)

    else:
        log.info(f"Unknown directive action ignored: {action}")


# Simple flag for run_now (thread-safe via GIL for bool assignment)
_run_now_flag = False


def _set_run_now():
    global _run_now_flag
    _run_now_flag = True


def _clear_run_now():
    global _run_now_flag
    _run_now_flag = False


def _handle_approved(article_id: str, client: IpcClient, db: MaterialDB, publisher: Publisher):
    """Publish the approved article and report the result."""
    article = pending_approvals.get(article_id)
    if not article:
        # Try loading from DB
        article = db.get_article(article_id)
    if not article:
        log.error(f"action_approved: article {article_id} not found in pending_approvals or DB")
        return

    log.info(f"Publishing approved article: {article_id}")
    try:
        publish_url = publisher.publish(article)
        db.update_article_status(article_id, "published", publish_url)
        pending_approvals.pop(article_id, None)

        # Report success back to brain
        client.consultation_request(
            mode="batch",
            items=[
                {
                    "id": f"published-{article_id}",
                    "content": (
                        f"Article published successfully.\n"
                        f"Title: {article['title']}\n"
                        f"URL: {publish_url}"
                    ),
                    "tentacleJudgment": "important",
                }
            ],
            summary=f"Article '{article['title']}' published to {PUBLISH_PLATFORM}: {publish_url}",
        )
        log.info(f"Article {article_id} published: {publish_url}")
    except Exception as e:
        log.error(f"Publish failed for article {article_id}: {e}")
        db.update_article_status(article_id, "publish_failed")
        client.consultation_request(
            mode="batch",
            items=[
                {
                    "id": f"publish-failed-{article_id}",
                    "content": f"Failed to publish article '{article.get('title', article_id)}': {e}",
                    "tentacleJudgment": "important",
                }
            ],
            summary=f"Publish failed for article '{article.get('title', article_id)}'",
        )


def _handle_rejected(article_id: str, db: MaterialDB):
    """Mark the rejected article and remove from pending."""
    article = pending_approvals.pop(article_id, None)
    db.update_article_status(article_id, "rejected")
    title = article.get("title", article_id) if article else article_id
    log.info(f"Article rejected by user: {article_id} — {title}")


# ── Collection cycle ──

def collect_materials(db: MaterialDB) -> int:
    """Fetch materials from Hacker News and store new ones. Returns count of new materials."""
    import requests

    new_count = 0
    url = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30"
    headers = {"User-Agent": "OpenCeph-ContentCreator/2.0"}

    for attempt in range(3):
        try:
            resp = requests.get(url, headers=headers, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            break
        except Exception as e:
            wait = 2 ** attempt
            log.warning(f"HN fetch attempt {attempt + 1} failed: {e}. Retrying in {wait}s...")
            time.sleep(wait)
    else:
        log.error("All HN fetch attempts failed; skipping collection cycle")
        return 0

    for hit in data.get("hits", []):
        title = hit.get("title", "").strip()
        story_url = hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID', '')}"
        content = (
            f"Points: {hit.get('points', 0)}, "
            f"Comments: {hit.get('num_comments', 0)}, "
            f"Author: {hit.get('author', '')}"
        )
        if not title:
            continue
        mid = db.add_material("hackernews", story_url, title, content)
        if mid:
            new_count += 1

    log.info(f"Collection cycle complete: {new_count} new materials stored")
    return new_count


# ── Analysis + article generation cycle ──

def run_analysis_cycle(
    db: MaterialDB,
    analyzer: ContentAnalyzer,
    writer: ArticleWriter,
    client: IpcClient,
    content_topics: str,
    writing_style: str,
):
    """Analyze accumulated materials, generate article drafts, send action_confirm reports."""
    materials = db.get_unanalyzed_materials()
    if len(materials) < 5:
        log.info(f"Only {len(materials)} unanalyzed materials; skipping analysis (need >= 5)")
        return

    log.info(f"Running analysis on {len(materials)} materials...")
    analysis = analyzer.analyze_materials(materials, content_topics)
    opportunities = analysis.get("opportunities", [])
    summary_text = analysis.get("summary", "")

    # Mark all analyzed materials
    for m in materials:
        db.mark_analyzed(m["id"])

    if not opportunities:
        log.info("No content opportunities identified this cycle")
        # Still report the summary
        if summary_text:
            client.consultation_request(
                mode="batch",
                items=[
                    {
                        "id": f"weekly-summary-{datetime.now(timezone.utc).strftime('%Y%m%d')}",
                        "content": summary_text,
                        "tentacleJudgment": "reference",
                    }
                ],
                summary=f"Weekly content analysis: no strong opportunities found. {summary_text}",
            )
        return

    log.info(f"Found {len(opportunities)} content opportunities")

    # Report weekly summary (informational batch, no publish action)
    client.consultation_request(
        mode="batch",
        items=[
            {
                "id": f"weekly-summary-{datetime.now(timezone.utc).strftime('%Y%m%d')}",
                "content": (
                    f"Weekly analysis complete. {summary_text}\n\n"
                    f"Top opportunities identified: "
                    + ", ".join(o.get("topic", "") for o in opportunities[:3])
                ),
                "tentacleJudgment": "reference",
            }
        ],
        summary=f"Weekly content analysis: {len(opportunities)} opportunities found",
    )

    # Generate articles for high-priority opportunities only
    high_priority = [o for o in opportunities if o.get("priority") == "high"][:2]
    if not high_priority:
        high_priority = opportunities[:1]  # fallback: take top opportunity

    for opportunity in high_priority:
        topic = opportunity.get("topic", "")
        if not topic:
            continue

        relevant_ids = set(opportunity.get("relevant_material_ids", []))
        relevant_materials = [m for m in materials if m["id"] in relevant_ids] or materials[:5]

        try:
            log.info(f"Generating outline for: {topic[:60]}")
            outline = analyzer.generate_article_outline(topic, relevant_materials, writing_style)

            log.info(f"Writing article for: {topic[:60]}")
            article = writer.write_article(outline, relevant_materials, writing_style)

            article_id = db.save_article(article["title"], article["content"])
            article["id"] = article_id

            # Store in pending approvals
            pending_approvals[article_id] = article

            # Send action_confirm — NEVER publish without this being approved
            _send_action_confirm(client, article_id, article)

        except Exception as e:
            log.error(f"Article generation failed for topic '{topic[:60]}': {e}")


def _send_action_confirm(client: IpcClient, article_id: str, article: dict):
    """Send an action_confirm consultation request for the given article draft."""
    title = article.get("title", "Untitled Article")
    content = article.get("content", "")
    preview = content[:500] + ("..." if len(content) > 500 else "")

    log.info(f"Sending action_confirm for article: {article_id} — {title[:60]}")
    client.consultation_request(
        mode="action_confirm",
        items=[
            {
                "type": "consultation_request",
                "mode": "action_confirm",
                "content": f"Article draft ready: {title}\n\n{preview}",
                "action": {"type": "publish_article", "article_id": article_id},
                "requires_confirmation": True,
            }
        ],
        summary=(
            f"New article draft ready for review: '{title}'. "
            "Approve to publish, or reject to discard."
        ),
    )


# ── Main ──

def main():
    global running, paused

    # --dry-run support
    if "--dry-run" in sys.argv:
        print("Content Creator Assistant — Dry Run")
        print(f"  Tentacle ID : {TENTACLE_ID}")
        print(f"  Socket Path : {SOCKET_PATH or '(not set)'}")
        print(f"  Trigger Mode: {TRIGGER_MODE}")
        print(f"  Platform    : {PUBLISH_PLATFORM}")
        print(f"  DB Path     : {DB_PATH}")
        print(f"  OpenRouter  : {'set' if OPENROUTER_API_KEY else 'NOT SET'}")
        print(f"  Feishu AppID: {'set' if FEISHU_APP_ID else 'NOT SET'}")
        print(f"  System Prompt loaded: {len(SYSTEM_PROMPT)} chars")
        sys.exit(0)

    # Validate required env vars
    missing = []
    if not SOCKET_PATH:
        missing.append("OPENCEPH_SOCKET_PATH")
    if not OPENROUTER_API_KEY:
        missing.append("OPENROUTER_API_KEY")
    if not FEISHU_APP_ID:
        missing.append("FEISHU_APP_ID")
    if not FEISHU_APP_SECRET:
        missing.append("FEISHU_APP_SECRET")
    if missing:
        log.error(f"Missing required environment variables: {', '.join(missing)}")
        sys.exit(1)

    # Read personalization from system prompt (placeholders already substituted by OpenCeph)
    # Use env fallbacks if placeholders were not substituted
    content_topics = os.environ.get("CONTENT_TOPICS", "AI, software engineering, technology trends")
    writing_style = os.environ.get("WRITING_STYLE", "technical, clear, in-depth")

    # Ensure data directory exists
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)

    # Initialize components
    db = MaterialDB(DB_PATH)
    db.init()

    feishu = FeishuBot(FEISHU_APP_ID, FEISHU_APP_SECRET)
    publisher = Publisher(feishu, PUBLISH_PLATFORM)
    analyzer = ContentAnalyzer(OPENROUTER_API_KEY)
    writer = ArticleWriter(OPENROUTER_API_KEY)

    # Connect IPC
    client = IpcClient(SOCKET_PATH, TENTACLE_ID)
    client.connect()

    # Bind directive handler with all dependencies via closure
    def on_directive(payload: dict):
        handle_directive(payload, client, db, publisher)

    client.on_directive(on_directive)
    client.register(
        purpose="收集内容素材、分析热点话题、生成文章草稿、等待用户确认后发布",
        runtime="python",
    )
    log.info(f"Registered as {TENTACLE_ID}")

    interval = parse_interval(COLLECT_INTERVAL)
    last_collect = 0.0
    last_analysis_week = -1  # ISO week number of last analysis run

    log.info(
        f"Content Creator Assistant started — collecting every {COLLECT_INTERVAL}, "
        f"analyzing on Mondays, publishing only after action_approved"
    )

    while running:
        if paused:
            time.sleep(1)
            continue

        now = time.time()
        should_run_now = _run_now_flag

        if should_run_now:
            _clear_run_now()

        # ── Daily collection ──
        if should_run_now or (now - last_collect) >= interval:
            log.info("Starting material collection cycle...")
            try:
                collect_materials(db)
            except Exception as e:
                log.error(f"Collection cycle error: {e}")
            last_collect = now

        # ── Weekly analysis (Mondays, or forced by run_now) ──
        current_week = datetime.now(timezone.utc).isocalendar()[1]
        if should_run_now or (is_monday() and current_week != last_analysis_week):
            log.info("Starting weekly analysis cycle...")
            try:
                run_analysis_cycle(db, analyzer, writer, client, content_topics, writing_style)
                last_analysis_week = current_week
            except Exception as e:
                log.error(f"Analysis cycle error: {e}")

        # Sleep 1 second per tick (check run_now flag frequently)
        for _ in range(60):
            if not running or _run_now_flag:
                break
            time.sleep(1)

    db.close()
    client.close()
    log.info("Content Creator Assistant stopped")


if __name__ == "__main__":
    main()
