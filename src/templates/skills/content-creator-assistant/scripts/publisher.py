"""
Article publisher — supports multiple publish targets.
"""

import requests
from typing import Optional


class Publisher:
    def __init__(self):
        pass

    def publish(self, title: str, content: str, target: str = "feishu_doc") -> dict:
        """
        Publish article to the specified target platform.
        Returns {"url": "...", "id": "..."} on success.
        """
        if target == "feishu_doc":
            return self._publish_feishu_doc(title, content)
        elif target == "notion":
            return self._publish_notion(title, content)
        else:
            # Fallback: save locally
            return self._save_local(title, content)

    def _publish_feishu_doc(self, title: str, content: str) -> dict:
        """
        Publish to Feishu Docs.
        In production, this would use the Feishu Docs API:
        POST https://open.feishu.cn/open-apis/docx/v1/documents
        """
        # Placeholder — CodeAgent will customize based on actual Feishu setup
        return {"url": f"feishu://doc/{title}", "id": "placeholder", "target": "feishu_doc"}

    def _publish_notion(self, title: str, content: str) -> dict:
        """
        Publish to Notion.
        In production, this would use the Notion API.
        """
        return {"url": f"notion://page/{title}", "id": "placeholder", "target": "notion"}

    def _save_local(self, title: str, content: str) -> dict:
        """Save article locally as a markdown file."""
        import os
        from datetime import datetime
        filename = f"article_{datetime.now().strftime('%Y%m%d_%H%M%S')}.md"
        filepath = os.path.join("articles", filename)
        os.makedirs("articles", exist_ok=True)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(f"# {title}\n\n{content}")
        return {"url": filepath, "id": filename, "target": "local"}
