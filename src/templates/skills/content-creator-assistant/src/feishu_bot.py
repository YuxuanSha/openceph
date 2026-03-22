"""
FeishuBot — Feishu (Lark) Open Platform API client
Handles tenant access token caching, messaging, and document creation.
"""

import logging
import time
from typing import Optional

import requests

log = logging.getLogger("feishu-bot")

FEISHU_BASE = "https://open.feishu.cn/open-apis"
TOKEN_TTL = 7000  # seconds — Feishu tokens expire in 7200s; refresh at 7000s


class FeishuBot:
    def __init__(self, app_id: str, app_secret: str):
        self.app_id = app_id
        self.app_secret = app_secret
        self._token: Optional[str] = None
        self._token_fetched_at: float = 0.0

    def get_tenant_access_token(self) -> str:
        """Return a valid tenant access token, fetching a new one if the cached one has expired."""
        now = time.time()
        if self._token and (now - self._token_fetched_at) < TOKEN_TTL:
            return self._token

        url = f"{FEISHU_BASE}/auth/v3/tenant_access_token/internal"
        payload = {"app_id": self.app_id, "app_secret": self.app_secret}
        resp = requests.post(url, json=payload, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        if data.get("code") != 0:
            raise RuntimeError(f"Feishu token error: {data.get('msg')} (code={data.get('code')})")

        self._token = data["tenant_access_token"]
        self._token_fetched_at = now
        log.info("Feishu tenant access token refreshed")
        return self._token

    def _auth_headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self.get_tenant_access_token()}",
            "Content-Type": "application/json; charset=utf-8",
        }

    def send_message(self, chat_id: str, text: str) -> bool:
        """Send a plain text message to a Feishu chat. Returns True on success."""
        url = f"{FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id"
        payload = {
            "receive_id": chat_id,
            "msg_type": "text",
            "content": '{"text": "' + text.replace('"', '\\"').replace("\n", "\\n") + '"}',
        }
        try:
            resp = requests.post(url, json=payload, headers=self._auth_headers(), timeout=15)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") != 0:
                log.error(f"Feishu send_message error: {data.get('msg')} (code={data.get('code')})")
                return False
            log.info(f"Message sent to chat {chat_id}")
            return True
        except Exception as e:
            log.error(f"Feishu send_message failed: {e}")
            return False

    def create_doc(self, title: str, content: str) -> str:
        """
        Create a Feishu document with the given title and Markdown content.
        Returns the document URL (e.g. https://xxx.feishu.cn/docx/...).
        """
        url = f"{FEISHU_BASE}/docx/v1/documents"
        payload = {
            "title": title,
            "folder_token": "",  # root folder; can be configured later
        }
        try:
            resp = requests.post(url, json=payload, headers=self._auth_headers(), timeout=15)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") != 0:
                raise RuntimeError(
                    f"Feishu create_doc error: {data.get('msg')} (code={data.get('code')})"
                )

            doc_token = data["data"]["document"]["document_id"]
            doc_url = f"https://feishu.cn/docx/{doc_token}"

            # Append content as raw text block
            self._append_doc_content(doc_token, content)

            log.info(f"Feishu doc created: {doc_url}")
            return doc_url
        except Exception as e:
            log.error(f"Feishu create_doc failed: {e}")
            raise

    def _append_doc_content(self, document_id: str, content: str):
        """Append content to an existing Feishu document as a text block."""
        url = f"{FEISHU_BASE}/docx/v1/documents/{document_id}/blocks/{document_id}/children"
        # Build a simple paragraph block per non-empty line (max 2000 chars per block)
        blocks = []
        for paragraph in content.split("\n\n"):
            paragraph = paragraph.strip()
            if not paragraph:
                continue
            # Truncate individual blocks to avoid API limits
            blocks.append({
                "block_type": 2,  # paragraph
                "paragraph": {
                    "elements": [
                        {
                            "type": "text_run",
                            "text_run": {
                                "content": paragraph[:2000],
                            },
                        }
                    ]
                },
            })

        if not blocks:
            return

        payload = {"children": blocks, "index": -1}
        try:
            resp = requests.post(url, json=payload, headers=self._auth_headers(), timeout=20)
            resp.raise_for_status()
            data = resp.json()
            if data.get("code") != 0:
                log.warning(
                    f"Feishu append content warning: {data.get('msg')} (code={data.get('code')})"
                )
        except Exception as e:
            log.warning(f"Feishu _append_doc_content failed: {e}")
