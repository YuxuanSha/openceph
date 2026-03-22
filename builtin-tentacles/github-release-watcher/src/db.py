import sqlite3
from pathlib import Path


class ReleaseStore:
    def __init__(self, db_path: Path):
        self.conn = sqlite3.connect(db_path)
        self.conn.execute("create table if not exists releases (release_key text primary key, created_at text)")
        self.conn.commit()

    def seen(self, release_key: str) -> bool:
        return bool(self.conn.execute("select 1 from releases where release_key = ?", (release_key,)).fetchone())

    def mark(self, release_key: str):
        self.conn.execute("insert or ignore into releases (release_key, created_at) values (?, datetime('now'))", (release_key,))
        self.conn.commit()
