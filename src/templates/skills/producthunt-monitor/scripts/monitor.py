#!/usr/bin/env python3
import json
import os
import socket
import sys
import threading
import time
import uuid
from pathlib import Path

import feedparser
import requests


RSS_URL = "https://www.producthunt.com/feed"
DEFAULT_INTERVAL_SECONDS = 6 * 60 * 60


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def send(sock, payload):
    sock.sendall((json.dumps(payload) + "\n").encode("utf-8"))


class ProductHuntMonitor:
    def __init__(self, sock, tentacle_id):
        self.sock = sock
        self.tentacle_id = tentacle_id
        self.state_path = Path(os.environ.get("OPENCEPH_STATE_PATH", ".producthunt-state.json"))
        self.seen = self._load_seen()
        self.lock = threading.Lock()

    def _load_seen(self):
        if not self.state_path.exists():
            return set()
        try:
            data = json.loads(self.state_path.read_text())
            return set(data.get("seen", []))
        except Exception:
            return set()

    def _save_seen(self):
        self.state_path.write_text(json.dumps({"seen": sorted(self.seen)}, indent=2))

    def register(self):
        send(self.sock, {
            "type": "tentacle_register",
            "sender": self.tentacle_id,
            "receiver": "brain",
            "payload": {"purpose": "Monitor Product Hunt launches", "runtime": "python"},
            "timestamp": now_iso(),
            "message_id": str(uuid.uuid4()),
        })

    def check_feed(self, reason):
        with self.lock:
            response = requests.get(RSS_URL, timeout=20)
            response.raise_for_status()
            feed = feedparser.parse(response.text)

            for entry in feed.entries[:10]:
                identifier = entry.get("id") or entry.get("link") or entry.get("title")
                if not identifier or identifier in self.seen:
                    continue
                self.seen.add(identifier)
                confidence = 0.9 if "producthunt.com/posts/" in (entry.get("link") or "") else 0.65
                summary = f"{entry.get('title', 'Untitled launch')} — {entry.get('summary', '')[:180]}"
                send(self.sock, {
                    "type": "report_finding",
                    "sender": self.tentacle_id,
                    "receiver": "brain",
                    "payload": {
                        "findingId": str(uuid.uuid4()),
                        "summary": summary,
                        "confidence": confidence,
                        "details": json.dumps({
                            "reason": reason,
                            "title": entry.get("title"),
                            "link": entry.get("link"),
                            "published": entry.get("published"),
                        }, ensure_ascii=False),
                    },
                    "timestamp": now_iso(),
                    "message_id": str(uuid.uuid4()),
                })

            self._save_seen()

    def reader_loop(self):
        buffer = ""
        while True:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            buffer += chunk.decode("utf-8")
            parts = buffer.split("\n")
            buffer = parts.pop() or ""
            for part in parts:
                if not part.strip():
                    continue
                try:
                    message = json.loads(part)
                except json.JSONDecodeError:
                    continue
                if message.get("type") == "heartbeat_trigger":
                    self.check_feed("heartbeat_trigger")


def main():
    socket_path = os.environ.get("OPENCEPH_SOCKET_PATH")
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "t_producthunt_monitor")
    interval_seconds = int(os.environ.get("INTERVAL_SECONDS", DEFAULT_INTERVAL_SECONDS))
    if not socket_path:
        print("missing OPENCEPH_SOCKET_PATH", file=sys.stderr)
        sys.exit(1)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(socket_path)

    monitor = ProductHuntMonitor(sock, tentacle_id)
    monitor.register()
    monitor.check_feed("startup")

    reader = threading.Thread(target=monitor.reader_loop, daemon=True)
    reader.start()

    while True:
        time.sleep(interval_seconds)
        monitor.check_feed("self_schedule")


if __name__ == "__main__":
    main()
