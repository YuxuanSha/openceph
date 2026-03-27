"""
HNClient — Fetch stories from the Hacker News Algolia API.

Uses requests (no urllib) for consistency with the rest of the skill.
"""

import logging
from datetime import datetime, timezone

import requests

log = logging.getLogger(__name__)

HN_FRONT_PAGE_URL = (
    "https://hn.algolia.com/api/v1/search"
    "?tags=front_page&hitsPerPage=50"
)
HN_SEARCH_URL = "https://hn.algolia.com/api/v1/search"

_HEADERS = {"User-Agent": "openceph-hn-digest/2.0"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class HNClient:
    """Fetch and lightly normalise HN Algolia API responses."""

    def __init__(
        self,
        min_score: int = 0,
        min_comments: int = 100,
        topics: list[str] | None = None,
        timeout: int = 20,
    ):
        self.min_score = min_score
        self.min_comments = min_comments
        self.topics = [t.strip().lower() for t in (topics or []) if t.strip()]
        self.timeout = timeout

    # ── Public API ──────────────────────────────────────────────────────────

    def fetch_top_stories(self) -> list[dict]:
        """Fetch front-page stories and return normalised story dicts."""
        try:
            resp = requests.get(
                HN_FRONT_PAGE_URL,
                headers=_HEADERS,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            hits = resp.json().get("hits", [])
        except Exception as exc:
            log.error("HN API request failed: %s", exc)
            return []

        stories = [self._normalise(h) for h in hits]
        return [s for s in stories if s is not None]

    def filter_stories(self, stories: list[dict]) -> list[dict]:
        """Apply score, comment, and topic filters (no dedup — that's StoryDatabase's job)."""
        results = []
        for story in stories:
            if story["score"] < self.min_score:
                continue
            if story["num_comments"] < self.min_comments:
                continue
            if self.topics:
                combined = (
                    story["title"].lower()
                    + " "
                    + (story["url"] or "").lower()
                    + " "
                    + " ".join(story["tags"])
                )
                if not any(t in combined for t in self.topics):
                    continue
            results.append(story)
        return results

    # ── Internals ────────────────────────────────────────────────────────────

    def _normalise(self, hit: dict) -> dict | None:
        object_id = hit.get("objectID", "")
        if not object_id:
            return None
        return {
            "objectID": object_id,
            "title": hit.get("title") or "Untitled",
            "url": hit.get("url") or "",
            "score": hit.get("points") or 0,
            "num_comments": hit.get("num_comments") or 0,
            "author": hit.get("author") or "",
            "created_at": hit.get("created_at") or _now_iso(),
            "tags": [t.lower() for t in (hit.get("_tags") or [])],
            "hn_url": f"https://news.ycombinator.com/item?id={object_id}",
        }
