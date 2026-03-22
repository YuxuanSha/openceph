"""
GitHub Project Assistant — Main tentacle process.
Connects to OpenCeph Brain via IPC, polls GitHub repos, classifies issues,
generates PR review summaries, and reports findings in batch.
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

from db import Database
from github_client import GitHubClient
from llm_reviewer import LLMReviewer

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

class GitHubAssistantAgent:
    def __init__(self):
        self.ipc = IpcConnection()
        self.db = Database()
        self.github = GitHubClient(os.environ.get("GITHUB_TOKEN", ""))
        self.llm = LLMReviewer(os.environ.get("OPENROUTER_API_KEY", ""))
        self.repos = json.loads(os.environ.get("GITHUB_REPOS", "[]"))
        self.running = True
        self.pending_items = []

    def register(self):
        self.ipc.send("tentacle_register", {
            "purpose": "GitHub project assistant — monitor repos, classify issues, review PRs",
            "runtime": "python",
        })

    def run(self):
        self.register()

        # Listen for directives in a separate thread
        directive_thread = threading.Thread(target=self._listen_directives, daemon=True)
        directive_thread.start()

        # Handle signals
        signal.signal(signal.SIGTERM, lambda *_: self._shutdown())
        signal.signal(signal.SIGINT, lambda *_: self._shutdown())

        trigger_mode = os.environ.get("OPENCEPH_TRIGGER_MODE", "self-schedule")

        if trigger_mode == "self-schedule":
            while self.running:
                self._poll_cycle()
                # Sleep 30 minutes between polls
                for _ in range(1800):
                    if not self.running:
                        break
                    time.sleep(1)
        else:
            # Wait for external trigger via directive
            while self.running:
                time.sleep(1)

    def _poll_cycle(self):
        """Main polling cycle: fetch new issues/PRs, classify, accumulate."""
        for repo_name in self.repos:
            try:
                # Fetch new issues
                new_issues = self.github.get_new_issues(repo_name, self.db.get_last_seen_issue(repo_name))
                for issue in new_issues:
                    if self.db.is_processed(repo_name, "issue", issue["number"]):
                        continue

                    classification = self.llm.classify_issue(issue)
                    self.db.mark_processed(repo_name, "issue", issue["number"], classification)

                    item = {
                        "id": f"issue-{repo_name}-{issue['number']}",
                        "content": f"[{classification['category']}] {repo_name}#{issue['number']}: {issue['title']}",
                        "tentacleJudgment": "important" if classification["priority"] == "high" else "reference",
                        "reason": classification.get("reason", ""),
                        "sourceUrl": issue.get("html_url", ""),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    }

                    # High priority bugs: report immediately
                    if classification["priority"] == "high" and classification["category"] == "bug":
                        self._report_urgent(item)
                    else:
                        self.pending_items.append(item)

                # Fetch new PRs
                new_prs = self.github.get_new_prs(repo_name, self.db.get_last_seen_pr(repo_name))
                for pr in new_prs:
                    if self.db.is_processed(repo_name, "pr", pr["number"]):
                        continue

                    review_summary = self.llm.review_pr(pr)
                    self.db.mark_processed(repo_name, "pr", pr["number"], {"review": review_summary})

                    self.pending_items.append({
                        "id": f"pr-{repo_name}-{pr['number']}",
                        "content": f"[PR Review] {repo_name}#{pr['number']}: {pr['title']}\n{review_summary}",
                        "tentacleJudgment": "reference",
                        "reason": "New PR with review summary",
                        "sourceUrl": pr.get("html_url", ""),
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })

            except Exception as e:
                print(f"Error polling {repo_name}: {e}", file=sys.stderr)

        # Check if we should batch report
        if len(self.pending_items) >= 3:
            self._batch_report()

    def _report_urgent(self, item: dict):
        """Immediately report a high-priority finding."""
        self.ipc.send("consultation_request", {
            "tentacle_id": self.ipc.tentacle_id,
            "request_id": str(uuid.uuid4()),
            "mode": "single",
            "summary": f"[Urgent] {item['content']}",
            "context": item.get("reason", ""),
        })

    def _batch_report(self):
        """Batch report accumulated items."""
        if not self.pending_items:
            return

        items = self.pending_items[:10]  # Max 10 per batch
        self.pending_items = self.pending_items[10:]

        summary_parts = [f"{i+1}. {item['content']}" for i, item in enumerate(items)]
        summary = f"GitHub 项目监控汇报 ({len(items)} items):\n" + "\n".join(summary_parts)

        self.ipc.send("consultation_request", {
            "tentacle_id": self.ipc.tentacle_id,
            "request_id": str(uuid.uuid4()),
            "mode": "batch",
            "items": items,
            "summary": summary,
            "context": f"Monitoring repos: {', '.join(self.repos)}",
        })

    def _listen_directives(self):
        """Listen for brain directives."""
        while self.running:
            try:
                msg = self.ipc.recv()
                if msg is None:
                    break
                if msg.get("type") == "directive":
                    action = msg.get("payload", {}).get("action", "")
                    if action == "kill":
                        self._shutdown()
                    elif action == "trigger":
                        self._poll_cycle()
                    elif action == "flush":
                        self._batch_report()
            except Exception:
                break

    def _shutdown(self):
        self.running = False
        # Flush any remaining items
        if self.pending_items:
            self._batch_report()
        self.db.close()
        self.ipc.close()
        sys.exit(0)


if __name__ == "__main__":
    agent = GitHubAssistantAgent()
    agent.run()
