"""
SQLite deduplication database for GitHub Issue Radar.
"""

import sqlite3
import logging
from datetime import datetime, timezone

log = logging.getLogger(__name__)


class IssueDatabase:
    def __init__(self, db_path: str):
        self._db_path = db_path
        self._conn: sqlite3.Connection | None = None

    def init(self):
        """Open the database connection and create tables if they do not exist."""
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("""
            CREATE TABLE IF NOT EXISTS seen_issues (
                url           TEXT PRIMARY KEY,
                title         TEXT,
                first_seen_at TEXT,
                notified_at   TEXT,
                relevance     TEXT
            )
        """)
        self._conn.commit()
        log.info(f"IssueDatabase initialised at {self._db_path}")

    def _now(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def is_seen(self, url: str) -> bool:
        """Return True if the issue URL has already been recorded."""
        assert self._conn is not None, "IssueDatabase.init() must be called first"
        cursor = self._conn.execute(
            "SELECT 1 FROM seen_issues WHERE url = ?", (url,)
        )
        return cursor.fetchone() is not None

    def mark_seen(self, url: str, title: str, relevance: str):
        """Record an issue URL as seen (INSERT OR IGNORE to be idempotent)."""
        assert self._conn is not None, "IssueDatabase.init() must be called first"
        self._conn.execute(
            """
            INSERT OR IGNORE INTO seen_issues (url, title, first_seen_at, notified_at, relevance)
            VALUES (?, ?, ?, NULL, ?)
            """,
            (url, title, self._now(), relevance),
        )
        self._conn.commit()

    def mark_notified(self, url: str):
        """Update the notified_at timestamp for an issue URL."""
        assert self._conn is not None, "IssueDatabase.init() must be called first"
        self._conn.execute(
            "UPDATE seen_issues SET notified_at = ? WHERE url = ?",
            (self._now(), url),
        )
        self._conn.commit()

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None
