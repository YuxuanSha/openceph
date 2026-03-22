import sqlite3
from pathlib import Path


class UptimeStore:
    def __init__(self, db_path: Path):
        self.conn = sqlite3.connect(db_path)
        self.conn.execute(
            "create table if not exists uptime ("
            "name text primary key, "
            "status text, "
            "latency_ms real, "
            "updated_at text, "
            "last_ok_at text, "
            "first_failure_at text, "
            "slow_streak integer default 0)"
        )
        self.conn.commit()

    def get(self, name: str):
        row = self.conn.execute(
            "select status, latency_ms, last_ok_at, first_failure_at, slow_streak from uptime where name = ?",
            (name,),
        ).fetchone()
        return None if row is None else {
            "status": row[0],
            "latency_ms": float(row[1]),
            "last_ok_at": row[2],
            "first_failure_at": row[3],
            "slow_streak": int(row[4] or 0),
        }

    def set(self, name: str, status: str, latency_ms: float, last_ok_at: str | None, first_failure_at: str | None, slow_streak: int):
        self.conn.execute(
            "insert into uptime (name, status, latency_ms, updated_at, last_ok_at, first_failure_at, slow_streak) "
            "values (?, ?, ?, datetime('now'), ?, ?, ?) "
            "on conflict(name) do update set "
            "status = excluded.status, latency_ms = excluded.latency_ms, updated_at = excluded.updated_at, "
            "last_ok_at = excluded.last_ok_at, first_failure_at = excluded.first_failure_at, slow_streak = excluded.slow_streak",
            (name, status, latency_ms, last_ok_at, first_failure_at, slow_streak),
        )
        self.conn.commit()
