"""
Content Creator Assistant — Main tentacle process.
Connects to OpenCeph Brain via IPC. Manages material collection via Feishu bot,
analyzes materials with LLM, generates article drafts, and handles publish flow.
"""

import json
import os
import socket
import sys
import time
import uuid
import threading
import signal
from datetime import datetime, timezone

from material_db import MaterialDB
from analyzer import MaterialAnalyzer
from article_writer import ArticleWriter
from feishu_bot import FeishuBot
from publisher import Publisher

# ── IPC Connection ───────────────────────────────────────────────

class IpcConnection:
    def __init__(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(os.environ["OPENCEPH_SOCKET_PATH"])
        self.tentacle_id = os.environ["OPENCEPH_TENTACLE_ID"]
        self._buf = b""

    def send(self, msg_type: str, payload: dict):
        msg = {
            "type": msg_type,
            "sender": self.tentacle_id,
            "receiver": "brain",
            "payload": payload,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "message_id": str(uuid.uuid4()),
        }
        self.sock.sendall((json.dumps(msg) + "\n").encode("utf-8"))

    def recv(self) -> dict | None:
        while True:
            if b"\n" in self._buf:
                line, self._buf = self._buf.split(b"\n", 1)
                return json.loads(line)
            chunk = self.sock.recv(4096)
            if not chunk:
                return None
            self._buf += chunk

    def close(self):
        self.sock.close()


# ── Tentacle Agent ───────────────────────────────────────────────

class ContentCreatorAgent:
    def __init__(self):
        self.ipc = IpcConnection()
        self.db = MaterialDB()
        self.analyzer = MaterialAnalyzer(os.environ.get("OPENROUTER_API_KEY", ""))
        self.writer = ArticleWriter(os.environ.get("OPENROUTER_API_KEY", ""))
        self.publisher = Publisher()
        self.running = True
        self.current_draft = None

        # Feishu bot for material collection
        self.feishu_bot = None
        feishu_app_id = os.environ.get("FEISHU_APP_ID")
        feishu_app_secret = os.environ.get("FEISHU_APP_SECRET")
        if feishu_app_id and feishu_app_secret:
            self.feishu_bot = FeishuBot(
                app_id=feishu_app_id,
                app_secret=feishu_app_secret,
                on_message=self._on_feishu_message,
            )

    def register(self):
        self.ipc.send("tentacle_register", {
            "purpose": "Content creator assistant — collect materials, write articles, publish",
            "runtime": "python",
        })

    def run(self):
        self.register()

        # Listen for directives
        directive_thread = threading.Thread(target=self._listen_directives, daemon=True)
        directive_thread.start()

        # Start Feishu bot if configured
        if self.feishu_bot:
            bot_thread = threading.Thread(target=self.feishu_bot.run, daemon=True)
            bot_thread.start()

        signal.signal(signal.SIGTERM, lambda *_: self._shutdown())
        signal.signal(signal.SIGINT, lambda *_: self._shutdown())

        trigger_mode = os.environ.get("OPENCEPH_TRIGGER_MODE", "self-schedule")

        if trigger_mode == "self-schedule":
            while self.running:
                self._daily_analysis()
                # Sleep 24 hours
                for _ in range(86400):
                    if not self.running:
                        break
                    time.sleep(1)
        else:
            while self.running:
                time.sleep(1)

    def _on_feishu_message(self, content: str, sender: str):
        """Handle incoming Feishu message (material from user)."""
        tags = self.analyzer.extract_tags(content)
        self.db.add_material(content=content, source="feishu", tags=tags, sender=sender)

    def _daily_analysis(self):
        """Analyze material library and generate article if ready."""
        try:
            materials = self.db.get_recent_materials(days=30)
            if not materials:
                return

            # Analyze topics
            topics = self.analyzer.find_topics(materials)
            ready_topics = [t for t in topics if t["material_count"] >= 5]

            if not ready_topics:
                # Weekly report on Mondays
                if datetime.now().weekday() == 0:
                    self._send_weekly_report(materials, topics)
                return

            # Generate article for the best topic
            best_topic = max(ready_topics, key=lambda t: t["material_count"])
            topic_materials = self.db.get_materials_by_tags(best_topic["tags"])
            draft = self.writer.generate_draft(best_topic["title"], topic_materials)

            self.current_draft = {
                "title": best_topic["title"],
                "content": draft,
                "topic": best_topic,
                "material_ids": [m["id"] for m in topic_materials],
            }

            # Request user review via action_confirm
            self.ipc.send("consultation_request", {
                "tentacle_id": self.ipc.tentacle_id,
                "request_id": str(uuid.uuid4()),
                "mode": "action_confirm",
                "action": {
                    "type": "publish_article",
                    "description": f"Article draft: {best_topic['title']} ({len(draft)} chars, based on {len(topic_materials)} materials)",
                    "content": draft,
                },
                "summary": f"Article draft completed: {best_topic['title']}",
                "context": f"Based on {len(topic_materials)} materials about {', '.join(best_topic['tags'])}",
            })

        except Exception as e:
            print(f"Analysis error: {e}", file=sys.stderr)

    def _send_weekly_report(self, materials: list, topics: list):
        """Send weekly material summary."""
        items = []
        for topic in topics[:5]:
            items.append({
                "id": f"topic-{topic['title'][:20]}",
                "content": f"Topic: {topic['title']} ({topic['material_count']} materials)",
                "tentacleJudgment": "reference",
                "reason": f"Tags: {', '.join(topic['tags'])}",
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })

        self.ipc.send("consultation_request", {
            "tentacle_id": self.ipc.tentacle_id,
            "request_id": str(uuid.uuid4()),
            "mode": "batch",
            "items": items,
            "summary": f"Weekly material report: {len(materials)} total materials, {len(topics)} identified topics",
            "context": "Weekly content creation status update",
        })

    def _listen_directives(self):
        """Listen for brain directives."""
        while self.running:
            try:
                msg = self.ipc.recv()
                if msg is None:
                    break
                if msg.get("type") == "directive":
                    payload = msg.get("payload", {})
                    action = payload.get("action", "")

                    if action == "kill":
                        self._shutdown()
                    elif action == "trigger":
                        self._daily_analysis()
                    elif action == "publish_confirmed":
                        self._do_publish(payload)
                    elif action == "revise":
                        self._revise_draft(payload.get("feedback", ""))
            except Exception:
                break

    def _revise_draft(self, feedback: str):
        """Revise current draft based on user feedback."""
        if not self.current_draft:
            return

        revised = self.writer.revise_draft(
            self.current_draft["content"],
            feedback,
        )
        self.current_draft["content"] = revised

        self.ipc.send("consultation_request", {
            "tentacle_id": self.ipc.tentacle_id,
            "request_id": str(uuid.uuid4()),
            "mode": "action_confirm",
            "action": {
                "type": "publish_article",
                "description": f"Revised draft: {self.current_draft['title']}",
                "content": revised,
            },
            "summary": f"Revised article draft: {self.current_draft['title']}",
            "context": f"Revised based on feedback: {feedback[:200]}",
        })

    def _do_publish(self, payload: dict):
        """Publish the current draft."""
        if not self.current_draft:
            return

        try:
            target = payload.get("target", "feishu_doc")
            result = self.publisher.publish(
                title=self.current_draft["title"],
                content=self.current_draft["content"],
                target=target,
            )

            self.db.mark_materials_used(self.current_draft["material_ids"])

            self.ipc.send("consultation_request", {
                "tentacle_id": self.ipc.tentacle_id,
                "request_id": str(uuid.uuid4()),
                "mode": "single",
                "summary": f"Article published: {self.current_draft['title']}",
                "context": f"Published to {target}. URL: {result.get('url', 'N/A')}",
            })

            self.current_draft = None
        except Exception as e:
            print(f"Publish error: {e}", file=sys.stderr)

    def _shutdown(self):
        self.running = False
        if self.feishu_bot:
            self.feishu_bot.stop()
        self.db.close()
        self.ipc.close()
        sys.exit(0)


if __name__ == "__main__":
    agent = ContentCreatorAgent()
    agent.run()
