"""
MaterialDB — SQLite persistence layer for collected materials and generated articles.
Uses stdlib sqlite3; no external dependencies.
"""

import logging
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Optional

log = logging.getLogger("material-db")


class MaterialDB:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._conn: Optional[sqlite3.Connection] = None

    def _get_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
        return self._conn

    def init(self):
        """Create database tables if they do not exist."""
        conn = self._get_conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS materials (
                id          TEXT PRIMARY KEY,
                source      TEXT NOT NULL,
                url         TEXT NOT NULL UNIQUE,
                title       TEXT NOT NULL,
                content     TEXT NOT NULL DEFAULT '',
                collected_at TEXT NOT NULL,
                analyzed    BOOLEAN NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS articles (
                id           TEXT PRIMARY KEY,
                title        TEXT NOT NULL,
                content      TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'draft',
                created_at   TEXT NOT NULL,
                published_at TEXT,
                publish_url  TEXT
            );
        """)
        conn.commit()
        log.info(f"MaterialDB initialized at {self.db_path}")

    def add_material(self, source: str, url: str, title: str, content: str) -> str:
        """
        Insert a new material record. Skips silently if the URL already exists.
        Returns the material ID (new or existing).
        """
        conn = self._get_conn()
        # Check for existing
        row = conn.execute("SELECT id FROM materials WHERE url = ?", (url,)).fetchone()
        if row:
            return row["id"]

        material_id = str(uuid.uuid4())
        collected_at = datetime.now(timezone.utc).isoformat()
        conn.execute(
            "INSERT INTO materials (id, source, url, title, content, collected_at, analyzed) "
            "VALUES (?, ?, ?, ?, ?, ?, 0)",
            (material_id, source, url, title, content, collected_at),
        )
        conn.commit()
        log.debug(f"Material added: {material_id} — {title[:60]}")
        return material_id

    def get_unanalyzed_materials(self) -> list[dict]:
        """Return all materials that have not yet been analyzed."""
        conn = self._get_conn()
        rows = conn.execute(
            "SELECT id, source, url, title, content, collected_at FROM materials WHERE analyzed = 0"
        ).fetchall()
        return [dict(row) for row in rows]

    def mark_analyzed(self, material_id: str):
        """Mark a material as analyzed."""
        conn = self._get_conn()
        conn.execute("UPDATE materials SET analyzed = 1 WHERE id = ?", (material_id,))
        conn.commit()

    def save_article(self, title: str, content: str) -> str:
        """
        Save a generated article draft.
        Returns the article ID.
        """
        article_id = str(uuid.uuid4())
        created_at = datetime.now(timezone.utc).isoformat()
        conn = self._get_conn()
        conn.execute(
            "INSERT INTO articles (id, title, content, status, created_at) VALUES (?, ?, ?, 'draft', ?)",
            (article_id, title, content, created_at),
        )
        conn.commit()
        log.info(f"Article draft saved: {article_id} — {title[:60]}")
        return article_id

    def get_article(self, article_id: str) -> Optional[dict]:
        """Return a single article by ID, or None if not found."""
        conn = self._get_conn()
        row = conn.execute("SELECT * FROM articles WHERE id = ?", (article_id,)).fetchone()
        return dict(row) if row else None

    def update_article_status(
        self, article_id: str, status: str, publish_url: Optional[str] = None
    ):
        """Update article status and optionally set publish_url and published_at."""
        conn = self._get_conn()
        if status == "published" and publish_url:
            published_at = datetime.now(timezone.utc).isoformat()
            conn.execute(
                "UPDATE articles SET status = ?, publish_url = ?, published_at = ? WHERE id = ?",
                (status, publish_url, published_at, article_id),
            )
        else:
            conn.execute(
                "UPDATE articles SET status = ? WHERE id = ?",
                (status, article_id),
            )
        conn.commit()
        log.info(f"Article {article_id} status → {status}")

    def close(self):
        if self._conn:
            self._conn.close()
            self._conn = None
