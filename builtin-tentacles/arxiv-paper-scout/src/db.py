import sqlite3
from pathlib import Path


class PaperStore:
    def __init__(self, db_path: Path):
        self.conn = sqlite3.connect(db_path)
        self.conn.execute("create table if not exists papers (paper_id text primary key, created_at text)")
        self.conn.commit()

    def seen(self, paper_id: str) -> bool:
        return bool(self.conn.execute("select 1 from papers where paper_id = ?", (paper_id,)).fetchone())

    def mark(self, paper_id: str):
        self.conn.execute("insert or ignore into papers (paper_id, created_at) values (?, datetime('now'))", (paper_id,))
        self.conn.commit()
