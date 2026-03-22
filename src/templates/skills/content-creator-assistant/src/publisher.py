"""
Publisher — Publishing coordinator for content articles.
Routes publish requests to the configured platform via FeishuBot.
"""

import logging
import os

from feishu_bot import FeishuBot

log = logging.getLogger("publisher")


class Publisher:
    def __init__(self, feishu_bot: FeishuBot, platform: str):
        """
        Args:
            feishu_bot: Initialized FeishuBot instance.
            platform: Publishing target — "feishu_doc" or "feishu_message".
        """
        self.feishu_bot = feishu_bot
        self.platform = platform

    def publish(self, article: dict) -> str:
        """
        Publish an article to the configured platform.

        Args:
            article: Dict with at minimum "title" (str) and "content" (str).

        Returns:
            A URL or confirmation string identifying the published artifact.

        Raises:
            ValueError: If the platform is not supported.
            RuntimeError: If publishing fails at the platform level.
        """
        title = article.get("title", "Untitled Article")
        content = article.get("content", "")

        log.info(f"Publishing article '{title[:60]}' to platform '{self.platform}'")

        if self.platform == "feishu_doc":
            url = self.feishu_bot.create_doc(title, content)
            log.info(f"Published to Feishu doc: {url}")
            return url

        elif self.platform == "feishu_message":
            chat_id = os.environ.get("FEISHU_CHAT_ID", "")
            if not chat_id:
                raise RuntimeError(
                    "FEISHU_CHAT_ID environment variable is required for feishu_message platform"
                )
            # Format message: title + content preview
            message = f"**{title}**\n\n{content[:1000]}"
            if len(content) > 1000:
                message += "\n\n[内容已截断，请查看完整版本]"
            success = self.feishu_bot.send_message(chat_id, message)
            if not success:
                raise RuntimeError(f"Feishu send_message failed for chat {chat_id}")
            result = f"feishu://message/{chat_id}"
            log.info(f"Published to Feishu message: {result}")
            return result

        else:
            raise ValueError(
                f"Unsupported publish platform: '{self.platform}'. "
                "Supported: 'feishu_doc', 'feishu_message'."
            )
