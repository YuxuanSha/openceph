"""
SQLite state management for tracking processed issues and PRs.
"""

import sqlite3
import os
from typing import Optional


class Database:
    def __init__(self, db_path: str = "state.db"):
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self._init_tables()

    def _init_tables(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS processed (
                repo TEXT NOT NULL,
                item_type TEXT NOT NULL,  -- 'issue' or 'pr'
                item_number INTEGER NOT NULL,
                data TEXT,
                processed_at TEXT DEFAULT (datetime('now')),
                PRIMARY KEY (repo, item_type, item_number)
            );
            CREATE TABLE IF NOT EXISTS last_seen (
                repo TEXT NOT NULL,
                item_type TEXT NOT NULL,
                last_number INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (repo, item_type)
            );
        """)
        self.conn.commit()

    def is_processed(self, repo: str, item_type: str, number: int) -> bool:
        row = self.conn.execute(
            "SELECT 1 FROM processed WHERE repo=? AND item_type=? AND item_number=?",
            (repo, item_type, number),
        ).fetchone()
        return row is not None

    def mark_processed(self, repo: str, item_type: str, number: int, data: dict | None = None):
        import json
        self.conn.execute(
            "INSERT OR REPLACE INTO processed (repo, item_type, item_number, data) VALUES (?, ?, ?, ?)",
            (repo, item_type, number, json.dumps(data) if data else None),
        )
        self.conn.execute(
            "INSERT OR REPLACE INTO last_seen (repo, item_type, last_number) VALUES (?, ?, MAX(?, COALESCE((SELECT last_number FROM last_seen WHERE repo=? AND item_type=?), 0)))",
            (repo, item_type, number, repo, item_type),
        )
        self.conn.commit()

    def get_last_seen_issue(self, repo: str) -> Optional[int]:
        row = self.conn.execute(
            "SELECT last_number FROM last_seen WHERE repo=? AND item_type='issue'",
            (repo,),
        ).fetchone()
        return row["last_number"] if row else None

    def get_last_seen_pr(self, repo: str) -> Optional[int]:
        row = self.conn.execute(
            "SELECT last_number FROM last_seen WHERE repo=? AND item_type='pr'",
            (repo,),
        ).fetchone()
        return row["last_number"] if row else None

    def close(self):
        self.conn.close()
