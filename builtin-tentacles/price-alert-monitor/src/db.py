import sqlite3
from pathlib import Path


class PriceStore:
    def __init__(self, db_path: Path):
        self.conn = sqlite3.connect(db_path)
        self.conn.execute("create table if not exists prices (name text primary key, value real, updated_at text)")
        self.conn.commit()

    def get(self, name: str):
        row = self.conn.execute("select value from prices where name = ?", (name,)).fetchone()
        return None if row is None else float(row[0])

    def set(self, name: str, value: float):
        self.conn.execute(
            "insert into prices (name, value, updated_at) values (?, ?, datetime('now')) "
            "on conflict(name) do update set value = excluded.value, updated_at = excluded.updated_at",
            (name, value),
        )
        self.conn.commit()
