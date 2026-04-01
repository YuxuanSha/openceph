"""
StateDB — SQLite-based state management for tentacles.

Provides deduplication (is_processed / mark_processed) and
simple key-value stats tracking.
"""

import os
import sqlite3
import time
from pathlib import Path
from typing import Optional


class StateDB:
    """SQLite state database for tentacle deduplication, stats, and key-value state."""

    def __init__(self, db_path: Optional[str | Path] = None):
        if db_path:
            self._db_path = Path(db_path)
        else:
            tentacle_dir = os.environ.get("OPENCEPH_TENTACLE_DIR", ".")
            data_dir = Path(tentacle_dir) / "data"
            data_dir.mkdir(parents=True, exist_ok=True)
            self._db_path = data_dir / "state.db"

        self._conn = sqlite3.connect(str(self._db_path))
        self._init_schema()

    def _init_schema(self) -> None:
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS processed_items (
                item_id TEXT PRIMARY KEY,
                processed_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS stats (
                key TEXT PRIMARY KEY,
                value REAL NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS kv_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at REAL NOT NULL
            );
        """)
        self._conn.commit()

    def is_processed(self, item_id: str) -> bool:
        """Check if an item has already been processed."""
        row = self._conn.execute(
            "SELECT 1 FROM processed_items WHERE item_id = ?", (item_id,)
        ).fetchone()
        return row is not None

    def mark_processed(self, item_id: str) -> None:
        """Mark an item as processed (idempotent)."""
        self._conn.execute(
            "INSERT OR IGNORE INTO processed_items (item_id, processed_at) VALUES (?, ?)",
            (item_id, time.time()),
        )
        self._conn.commit()

    def get_processed_count(self) -> int:
        """Return total number of processed items."""
        row = self._conn.execute("SELECT COUNT(*) FROM processed_items").fetchone()
        return row[0] if row else 0

    def increment_stat(self, key: str, amount: float = 1) -> float:
        """Increment a stat counter, return new value."""
        self._conn.execute(
            "INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + ?",
            (key, amount, amount),
        )
        self._conn.commit()
        return self.get_stat(key)

    def get_stat(self, key: str) -> float:
        """Get current value of a stat counter."""
        row = self._conn.execute("SELECT value FROM stats WHERE key = ?", (key,)).fetchone()
        return row[0] if row else 0

    def set_stat(self, key: str, value: float) -> None:
        """Set a stat counter to a specific value."""
        self._conn.execute(
            "INSERT INTO stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
            (key, value, value),
        )
        self._conn.commit()

    # ─── General key-value state (per protocol §StateDB) ──────

    def set_state(self, key: str, value: str) -> None:
        """Store an arbitrary key-value pair (JSON string recommended for complex values)."""
        self._conn.execute(
            "INSERT INTO kv_state (key, value, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?",
            (key, value, time.time(), value, time.time()),
        )
        self._conn.commit()

    def get_state(self, key: str, default: Optional[str] = None) -> Optional[str]:
        """Retrieve a stored state value by key."""
        row = self._conn.execute(
            "SELECT value FROM kv_state WHERE key = ?", (key,)
        ).fetchone()
        return row[0] if row else default

    def close(self) -> None:
        """Close the database connection."""
        self._conn.close()
