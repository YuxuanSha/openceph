"""
StoryDatabase — SQLite deduplication store for HN Engineering Digest.

Uses the Python stdlib sqlite3 module. No external dependencies.
"""

import sqlite3
import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class StoryDatabase:
    """Persist seen HN stories to prevent duplicate reports."""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._conn: sqlite3.Connection | None = None

    def init(self):
        """Open connection and create schema if not present."""
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS seen_stories (
                story_id      TEXT PRIMARY KEY,
                title         TEXT,
                url           TEXT,
                first_seen_at TEXT,
                notified_at   TEXT,
                quality_score REAL
            )
            """
        )
        self._conn.commit()
        log.debug("StoryDatabase initialised at %s", self.db_path)

    def is_seen(self, story_id: str) -> bool:
        """Return True if the story has already been recorded."""
        if self._conn is None:
            raise RuntimeError("StoryDatabase.init() must be called before use")
        row = self._conn.execute(
            "SELECT 1 FROM seen_stories WHERE story_id = ?",
            (story_id,),
        ).fetchone()
        return row is not None

    def mark_seen(self, story_id: str, title: str, url: str, quality_score: float):
        """Record a story as seen (insert or ignore if already present)."""
        if self._conn is None:
            raise RuntimeError("StoryDatabase.init() must be called before use")
        self._conn.execute(
            """
            INSERT OR IGNORE INTO seen_stories
                (story_id, title, url, first_seen_at, notified_at, quality_score)
            VALUES (?, ?, ?, ?, NULL, ?)
            """,
            (story_id, title, url, _now_iso(), quality_score),
        )
        self._conn.commit()

    def mark_notified(self, story_id: str):
        """Set notified_at timestamp for a story that has been reported to brain."""
        if self._conn is None:
            raise RuntimeError("StoryDatabase.init() must be called before use")
        self._conn.execute(
            "UPDATE seen_stories SET notified_at = ? WHERE story_id = ?",
            (_now_iso(), story_id),
        )
        self._conn.commit()

    def close(self):
        if self._conn is not None:
            self._conn.close()
            self._conn = None
