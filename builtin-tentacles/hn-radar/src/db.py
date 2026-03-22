import sqlite3
from pathlib import Path


class SeenStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.execute("create table if not exists seen (item_id text primary key, created_at text)")
        self.conn.execute("create table if not exists meta (key text primary key, value text)")
        self.conn.commit()

    def seen(self, item_id: str) -> bool:
        row = self.conn.execute("select 1 from seen where item_id = ?", (item_id,)).fetchone()
        return bool(row)

    def mark(self, item_id: str):
        self.conn.execute("insert or ignore into seen (item_id, created_at) values (?, datetime('now'))", (item_id,))
        self.conn.commit()

    def get_meta(self, key: str, default: str = "") -> str:
        row = self.conn.execute("select value from meta where key = ?", (key,)).fetchone()
        return default if row is None else str(row[0])

    def set_meta(self, key: str, value: str):
        self.conn.execute(
            "insert into meta (key, value) values (?, ?) "
            "on conflict(key) do update set value = excluded.value",
            (key, value),
        )
        self.conn.commit()
