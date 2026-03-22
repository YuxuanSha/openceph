"""
ArticleWriter — LLM-powered full article generation from an outline.
Uses OpenRouter API via requests.
"""

import json
import logging

import requests

log = logging.getLogger("article-writer")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


class ArticleWriter:
    def __init__(self, api_key: str, model: str = "openai/gpt-4o"):
        self.api_key = api_key
        self.model = model

    def _call_llm(self, messages: list[dict], max_tokens: int = 3000) -> str:
        """Call OpenRouter chat completions API. Returns the assistant message content."""
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens,
        }
        resp = requests.post(OPENROUTER_URL, json=payload, headers=headers, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()

    def write_article(
        self, outline: str, materials: list[dict], writing_style: str
    ) -> dict:
        """
        Generate a full article from an outline and supporting materials.

        Args:
            outline: Structured article outline in Markdown (from ContentAnalyzer).
            materials: List of material dicts with title and content to draw insights from.
            writing_style: User-configured writing style string.

        Returns:
            Dict with keys:
              - "title": str — the article title
              - "content": str — the full article body in Markdown
        """
        material_context = "\n\n".join(
            f"### {m['title']}\n{m['content'][:400]}" for m in materials[:8]
        )

        messages = [
            {
                "role": "system",
                "content": (
                    "You are an expert technical writer. Write complete, high-quality articles "
                    "in Markdown format. Be original — synthesize insights from the source "
                    "materials rather than summarizing them. Follow the outline structure "
                    "precisely. Return a JSON object with 'title' and 'content' keys only."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Writing style: {writing_style}\n\n"
                    f"Outline to follow:\n{outline}\n\n"
                    f"Reference materials for insights:\n{material_context}\n\n"
                    "Write the complete article. Extract the title from the outline's first "
                    "heading and put the rest as content.\n\n"
                    "Return JSON: {\"title\": \"...\", \"content\": \"...\"}"
                ),
            },
        ]

        try:
            raw = self._call_llm(messages, max_tokens=3000)
            # Strip markdown code fences if present
            raw = raw.strip()
            if raw.startswith("```"):
                raw = raw.split("```", 2)[1]
                if raw.startswith("json"):
                    raw = raw[4:]
                raw = raw.strip()

            result = json.loads(raw)
            title = result.get("title", "Untitled Article")
            content = result.get("content", "")
            log.info(f"Article written: {title[:60]} ({len(content)} chars)")
            return {"title": title, "content": content}
        except json.JSONDecodeError:
            # Fallback: treat entire output as content, extract title from first line
            lines = raw.split("\n")
            title = lines[0].lstrip("#").strip() if lines else "Untitled Article"
            content = "\n".join(lines[1:]).strip() if len(lines) > 1 else raw
            log.warning("ArticleWriter: JSON parse failed, using raw text fallback")
            return {"title": title, "content": content}
        except Exception as e:
            log.error(f"ArticleWriter.write_article failed: {e}")
            raise
