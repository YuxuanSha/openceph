"""
Standalone Feishu bot for material collection.
Receives messages from users and forwards them to the material callback.
"""

import json
import time
import hashlib
import hmac
import requests
from typing import Callable, Optional


class FeishuBot:
    TOKEN_URL = "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal"

    def __init__(self, app_id: str, app_secret: str,
                 on_message: Callable[[str, str], None]):
        self.app_id = app_id
        self.app_secret = app_secret
        self.on_message = on_message
        self.running = True
        self._token: Optional[str] = None
        self._token_expires = 0

    def _get_token(self) -> str:
        """Get or refresh tenant access token."""
        if self._token and time.time() < self._token_expires:
            return self._token

        resp = requests.post(self.TOKEN_URL, json={
            "app_id": self.app_id,
            "app_secret": self.app_secret,
        }, timeout=10)
        data = resp.json()
        self._token = data.get("tenant_access_token", "")
        self._token_expires = time.time() + data.get("expire", 7200) - 300
        return self._token

    def run(self):
        """
        Long-poll or WebSocket connection to receive Feishu events.
        In production, this would use Feishu's event subscription (WebSocket mode).
        Here we use a simplified polling approach.
        """
        while self.running:
            try:
                # In a real implementation, this would be a WebSocket connection
                # to wss://open.feishu.cn/ws/ or an HTTP callback server.
                # For the SKILL template, we provide the structure — the CodeAgent
                # will customize this based on the user's actual Feishu setup.
                time.sleep(30)
            except Exception:
                if not self.running:
                    break
                time.sleep(5)

    def handle_event(self, event: dict):
        """Process a Feishu event (called from webhook or WebSocket handler)."""
        event_type = event.get("header", {}).get("event_type", "")

        if event_type == "im.message.receive_v1":
            msg = event.get("event", {}).get("message", {})
            content_str = msg.get("content", "{}")
            sender = event.get("event", {}).get("sender", {}).get("sender_id", {}).get("open_id", "unknown")

            try:
                content = json.loads(content_str)
                text = content.get("text", "")
            except Exception:
                text = content_str

            if text:
                self.on_message(text, sender)

    def stop(self):
        self.running = False
