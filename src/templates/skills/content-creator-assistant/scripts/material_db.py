"""
SQLite material database for storing collected content.
"""

import sqlite3
import json
from datetime import datetime, timedelta, timezone
from typing import Optional


class MaterialDB:
    def __init__(self, db_path: str = "materials.db"):
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self._init_tables()

    def _init_tables(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS materials (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL,
                source TEXT DEFAULT 'manual',
                tags TEXT DEFAULT '[]',
                sender TEXT,
                used INTEGER DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
        """)
        self.conn.commit()

    def add_material(self, content: str, source: str = "manual",
                     tags: list[str] | None = None, sender: str | None = None):
        self.conn.execute(
            "INSERT INTO materials (content, source, tags, sender) VALUES (?, ?, ?, ?)",
            (content, source, json.dumps(tags or []), sender),
        )
        self.conn.commit()

    def get_recent_materials(self, days: int = 30) -> list[dict]:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
        rows = self.conn.execute(
            "SELECT * FROM materials WHERE created_at >= ? AND used = 0 ORDER BY created_at DESC",
            (cutoff,),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_materials_by_tags(self, tags: list[str]) -> list[dict]:
        results = []
        for row in self.conn.execute("SELECT * FROM materials WHERE used = 0").fetchall():
            row_tags = json.loads(row["tags"])
            if any(t in row_tags for t in tags):
                results.append(dict(row))
        return results

    def mark_materials_used(self, material_ids: list[int]):
        if not material_ids:
            return
        placeholders = ",".join("?" * len(material_ids))
        self.conn.execute(
            f"UPDATE materials SET used = 1 WHERE id IN ({placeholders})",
            material_ids,
        )
        self.conn.commit()

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM materials").fetchone()[0]

    def close(self):
        self.conn.close()
