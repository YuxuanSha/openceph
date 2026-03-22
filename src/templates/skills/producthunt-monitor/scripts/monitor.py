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
    sock.sendall((json.dumps(payload) + "\n").encode("utf-8"))


class ProductHuntMonitor:
    def __init__(self, sock, tentacle_id):
        self.sock = sock
        self.tentacle_id = tentacle_id
        self.state_path = Path(os.environ.get("OPENCEPH_STATE_PATH", ".producthunt-state.json"))
        self.findings_path = Path(os.environ.get("OPENCEPH_FINDINGS_PATH", ".producthunt-findings.jsonl"))
        self.seen = self._load_seen()
        self.lock = threading.Lock()
        self.stop_requested = False
        self.trigger_mode = os.environ.get("OPENCEPH_TRIGGER_MODE", "self")
        self.interval_seconds = parse_interval_seconds(os.environ.get("INTERVAL_SECONDS", "6h"))

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

    def _append_finding(self, item):
        self.findings_path.parent.mkdir(parents=True, exist_ok=True)
        with self.findings_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")

    def _load_recent_findings(self, limit=20):
        if not self.findings_path.exists():
            return []
        try:
            lines = self.findings_path.read_text(encoding="utf-8").splitlines()
            return [json.loads(line) for line in lines if line.strip()][-limit:]
        except Exception:
            return []

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
                details = {
                    "reason": reason,
                    "title": entry.get("title"),
                    "link": entry.get("link"),
                    "published": entry.get("published"),
                }
                self._append_finding({
                    "ts": now_iso(),
                    "confidence": confidence,
                    "title": entry.get("title"),
                    "link": entry.get("link"),
                    "summary": summary,
                })
                send(self.sock, {
                    "type": "report_finding" if confidence >= 0.8 else "consultation_request",
                    "sender": self.tentacle_id,
                    "receiver": "brain",
                    "payload": {
                        "findingId": str(uuid.uuid4()),
                        "summary": summary,
                        "confidence": confidence,
                        "details": json.dumps(details, ensure_ascii=False),
                    },
                    "timestamp": now_iso(),
                    "message_id": str(uuid.uuid4()),
                })

            self._save_seen()

    def do_heartbeat_review(self, prompt):
        recent_findings = self._load_recent_findings()
        high_value_count = len([item for item in recent_findings if item.get("confidence", 0) >= 0.8])
        rate = high_value_count / len(recent_findings) if recent_findings else 0

        if len(recent_findings) == 0:
            adjustments = [{
                "type": "change_frequency",
                "description": "连续无发现，建议降低频率",
                "params": {"new_interval": "12h"},
            }]
        elif rate > 0.5:
            adjustments = [{
                "type": "change_frequency",
                "description": "高价值发现率高，建议提高频率",
                "params": {"new_interval": "3h"},
            }]
        else:
            adjustments = []

        send(self.sock, {
            "type": "heartbeat_result",
            "sender": self.tentacle_id,
            "receiver": "brain",
            "payload": {
                "tentacle_id": self.tentacle_id,
                "status": "acted" if adjustments else "ok",
                "actions": [
                    "reviewed recent findings",
                    f"prompt={prompt}",
                    f"recent_findings={len(recent_findings)}",
                ],
                "adjustments": adjustments,
            },
            "timestamp": now_iso(),
            "message_id": str(uuid.uuid4()),
        })

    def handle_directive(self, directive):
        action = (directive or {}).get("action")
        if action == "run_now":
            self.check_feed("directive_run_now")
        elif action == "kill":
            self.stop_requested = True
        elif action == "set_self_schedule":
            self.trigger_mode = "self"
            interval = (directive or {}).get("interval")
            if interval:
                self.interval_seconds = parse_interval_seconds(interval)
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
                elif message.get("type") == "heartbeat_trigger":
                    payload = message.get("payload") or {}
                    self.do_heartbeat_review(payload.get("prompt", "review recent findings"))


def main():
    socket_path = os.environ.get("OPENCEPH_SOCKET_PATH")
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "t_producthunt_monitor")
    if not socket_path:
        print("missing OPENCEPH_SOCKET_PATH", file=sys.stderr)
        sys.exit(1)

    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(socket_path)

    monitor = ProductHuntMonitor(sock, tentacle_id)
    monitor.register()

    reader = threading.Thread(target=monitor.reader_loop, daemon=True)
    reader.start()

    if monitor.trigger_mode == "self":
        monitor.check_feed("startup")

    while not monitor.stop_requested:
        if monitor.trigger_mode == "self":
            time.sleep(monitor.interval_seconds)
            if monitor.stop_requested:
                break
            monitor.check_feed("self_schedule")
        else:
            time.sleep(1)


if __name__ == "__main__":
    main()
