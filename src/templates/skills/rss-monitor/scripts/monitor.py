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


DEFAULT_INTERVAL_SECONDS = 3 * 60 * 60
DEFAULT_FEEDS = "https://hnrss.org/frontpage,https://planetpython.org/rss20.xml"


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def parse_interval_seconds(value):
    raw = (value or "").strip().lower()
    if not raw:
        return DEFAULT_INTERVAL_SECONDS
    if raw.endswith("ms"):
        return max(1, int(raw[:-2]) / 1000)
    if raw.endswith("s"):
        return max(1, int(raw[:-1]))
    if raw.endswith("m"):
        return max(1, int(raw[:-1]) * 60)
    if raw.endswith("h"):
        return max(1, int(raw[:-1]) * 3600)
    if raw.endswith("d"):
        return max(1, int(raw[:-1]) * 86400)
    return DEFAULT_INTERVAL_SECONDS


def send(sock, payload):
    sock.sendall((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))


class RssMonitor:
    def __init__(self, sock, tentacle_id):
        self.sock = sock
        self.tentacle_id = tentacle_id
        self.state_path = Path(os.environ.get("OPENCEPH_STATE_PATH", ".rss-monitor-state.json"))
        self.trigger_mode = os.environ.get("OPENCEPH_TRIGGER_MODE", "self")
        self.interval_seconds = parse_interval_seconds(os.environ.get("INTERVAL_SECONDS", "3h"))
        self.feed_urls = [item.strip() for item in os.environ.get("RSS_FEEDS", DEFAULT_FEEDS).split(",") if item.strip()]
        self.stop_requested = False
        self.seen = self._load_seen()
        self.lock = threading.Lock()

    def _load_seen(self):
        if not self.state_path.exists():
            return set()
        try:
            data = json.loads(self.state_path.read_text(encoding="utf-8"))
            return set(data.get("seen", []))
        except Exception:
            return set()

    def _save_seen(self):
        self.state_path.write_text(json.dumps({"seen": sorted(self.seen)}, indent=2), encoding="utf-8")

    def register(self):
        send(self.sock, {
            "type": "tentacle_register",
            "sender": self.tentacle_id,
            "receiver": "brain",
            "payload": {"purpose": "Monitor RSS and Atom feeds", "runtime": "python"},
            "timestamp": now_iso(),
            "message_id": str(uuid.uuid4()),
        })

    def _score_entry(self, entry):
        title = (entry.get("title") or "").lower()
        summary = (entry.get("summary") or "").lower()
        text = f"{title}\n{summary}"
        if any(flag in text for flag in ["release", "security", "incident", "breaking"]):
            return "important"
        if len(summary) > 80:
            return "reference"
        return "uncertain"

    def poll_once(self, reason):
        items = []
        with self.lock:
            for feed_url in self.feed_urls:
                response = requests.get(feed_url, timeout=20)
                response.raise_for_status()
                parsed = feedparser.parse(response.text)
                for entry in parsed.entries[:8]:
                    identifier = entry.get("id") or entry.get("guid") or entry.get("link") or entry.get("title")
                    if not identifier or identifier in self.seen:
                        continue
                    self.seen.add(identifier)
                    judgment = self._score_entry(entry)
                    items.append({
                        "id": str(uuid.uuid4()),
                        "content": f"{entry.get('title', 'Untitled')} — {entry.get('link', '')}",
                        "tentacleJudgment": judgment,
                        "reason": f"feed={feed_url}; trigger={reason}",
                        "sourceUrl": entry.get("link"),
                        "timestamp": now_iso(),
                    })
            self._save_seen()

        if not items:
            return

        send(self.sock, {
            "type": "consultation_request",
            "sender": self.tentacle_id,
            "receiver": "brain",
            "payload": {
                "tentacle_id": self.tentacle_id,
                "request_id": str(uuid.uuid4()),
                "mode": "batch",
                "items": items,
                "summary": f"Collected {len(items)} new feed items",
                "context": "Batch feed review",
            },
            "timestamp": now_iso(),
            "message_id": str(uuid.uuid4()),
        })

    def handle_directive(self, directive):
        action = (directive or {}).get("action")
        if action == "run_now":
            self.poll_once("directive_run_now")
        elif action == "kill":
            self.stop_requested = True
        elif action == "set_self_schedule":
            self.trigger_mode = "self"
            if (directive or {}).get("interval"):
                self.interval_seconds = parse_interval_seconds(directive["interval"])
        elif action == "set_trigger_mode":
            self.trigger_mode = (directive or {}).get("triggerMode", self.trigger_mode)

    def reader_loop(self):
        buffer = ""
        while not self.stop_requested:
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
                if message.get("type") == "directive":
                    self.handle_directive(message.get("payload") or {})


def main():
    socket_path = os.environ.get("OPENCEPH_SOCKET_PATH")
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "t_rss_monitor")
    if not socket_path:
        print("missing OPENCEPH_SOCKET_PATH", file=sys.stderr)
        sys.exit(1)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(socket_path)

    monitor = RssMonitor(sock, tentacle_id)
    monitor.register()

    reader = threading.Thread(target=monitor.reader_loop, daemon=True)
    reader.start()

    if monitor.trigger_mode == "self":
        monitor.poll_once("startup")

    while not monitor.stop_requested:
        if monitor.trigger_mode == "self":
            time.sleep(monitor.interval_seconds)
            if monitor.stop_requested:
                break
            monitor.poll_once("self_schedule")
        else:
            time.sleep(1)


if __name__ == "__main__":
    main()
