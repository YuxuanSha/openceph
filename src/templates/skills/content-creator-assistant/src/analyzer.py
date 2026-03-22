"""
ContentAnalyzer — LLM-powered content analysis and article outline generation.
Uses OpenRouter API via requests.
"""

import json
import logging

import requests

log = logging.getLogger("content-analyzer")

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


class ContentAnalyzer:
    def __init__(self, api_key: str, model: str = "openai/gpt-4o-mini"):
        self.api_key = api_key
        self.model = model

    def _call_llm(self, messages: list[dict], max_tokens: int = 1024) -> str:
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
        resp = requests.post(OPENROUTER_URL, json=payload, headers=headers, timeout=60)
        resp.raise_for_status()
        data = resp.json()
        return data["choices"][0]["message"]["content"].strip()

    def analyze_materials(self, materials: list[dict], content_topics: str) -> dict:
        """
        Analyze a batch of collected materials and identify content opportunities.

        Args:
            materials: List of material dicts with keys: title, url, source, content.
            content_topics: User-configured topics string (from CONTENT_TOPICS placeholder).

        Returns:
            Dict with keys:
              - "opportunities": list of dicts [{topic, rationale, relevant_material_ids, priority}]
              - "summary": human-readable analysis summary string
        """
        if not materials:
            return {"opportunities": [], "summary": "No materials to analyze."}

        material_list = "\n".join(
            f"- [{m['source']}] {m['title']} (id={m['id']})"
            for m in materials[:50]  # cap to avoid token overflow
        )

        messages = [
            {
                "role": "system",
                "content": (
                    "You are a content strategy analyst. Your job is to analyze a list of "
                    "collected materials and identify the best opportunities for original articles "
                    "given the user's content topics. Return a JSON object only."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"User's content topics: {content_topics}\n\n"
                    f"Collected materials ({len(materials)} items):\n{material_list}\n\n"
                    "Identify the top 3-5 content opportunities. For each opportunity, provide:\n"
                    "- topic: a specific article topic (not just a theme)\n"
                    "- rationale: why this topic is worth writing about now\n"
                    "- relevant_material_ids: list of material IDs that support this topic\n"
                    "- priority: 'high', 'medium', or 'low'\n\n"
                    "Also provide a brief 'summary' of the overall content landscape.\n\n"
                    "Return JSON: {\"opportunities\": [...], \"summary\": \"...\"}"
                ),
            },
        ]

        try:
            raw = self._call_llm(messages, max_tokens=1500)
            # Strip markdown code fences if present
            raw = raw.strip()
            if raw.startswith("```"):
                raw = raw.split("```", 2)[1]
                if raw.startswith("json"):
                    raw = raw[4:]
                raw = raw.strip()
            result = json.loads(raw)
            log.info(
                f"Analysis complete: {len(result.get('opportunities', []))} opportunities found"
            )
            return result
        except Exception as e:
            log.error(f"ContentAnalyzer.analyze_materials failed: {e}")
            return {"opportunities": [], "summary": f"Analysis failed: {e}"}

    def generate_article_outline(
        self, topic: str, materials: list[dict], writing_style: str
    ) -> str:
        """
        Generate a structured article outline for the given topic.

        Args:
            topic: The specific article topic to outline.
            materials: Relevant materials to draw from.
            writing_style: User-configured writing style string.

        Returns:
            A structured outline string (Markdown format).
        """
        material_snippets = "\n".join(
            f"- {m['title']}: {m['content'][:200]}" for m in materials[:10]
        )

        messages = [
            {
                "role": "system",
                "content": (
                    "You are an expert content strategist and writer. "
                    "Generate detailed, actionable article outlines in Markdown format."
                ),
            },
            {
                "role": "user",
                "content": (
                    f"Topic: {topic}\n\n"
                    f"Writing style: {writing_style}\n\n"
                    f"Reference materials:\n{material_snippets}\n\n"
                    "Generate a detailed article outline with:\n"
                    "1. A compelling title\n"
                    "2. Introduction angle\n"
                    "3. Main sections (3-5) with sub-points\n"
                    "4. Conclusion direction\n"
                    "5. Key takeaways for the reader\n\n"
                    "Format as Markdown."
                ),
            },
        ]

        try:
            outline = self._call_llm(messages, max_tokens=1000)
            log.info(f"Outline generated for topic: {topic[:60]}")
            return outline
        except Exception as e:
            log.error(f"ContentAnalyzer.generate_article_outline failed: {e}")
            raise
