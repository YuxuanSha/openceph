"""
LLM-powered material analysis — tag extraction and topic identification.
"""

import json
from openai import OpenAI


class MaterialAnalyzer:
    def __init__(self, api_key: str, model: str = "anthropic/claude-haiku-4-5"):
        self.client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key,
        ) if api_key else None
        self.model = model

    def extract_tags(self, content: str) -> list[str]:
        """Extract topic tags from a piece of content."""
        if not self.client:
            return []

        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=[{
                    "role": "user",
                    "content": f"Extract 1-5 topic tags from this text. Return JSON array of strings only.\n\n{content[:500]}",
                }],
                max_tokens=100,
                temperature=0.1,
            )
            text = resp.choices[0].message.content.strip()
            start = text.find("[")
            end = text.rfind("]") + 1
            if start >= 0 and end > start:
                return json.loads(text[start:end])
        except Exception:
            pass
        return []

    def find_topics(self, materials: list[dict]) -> list[dict]:
        """Analyze materials to find publishable topics."""
        if not self.client or not materials:
            return []

        # Summarize materials for LLM
        summaries = []
        for m in materials[:50]:
            tags = json.loads(m.get("tags", "[]")) if isinstance(m.get("tags"), str) else m.get("tags", [])
            summaries.append(f"- {m['content'][:100]} [tags: {', '.join(tags)}]")

        prompt = f"""Analyze these {len(summaries)} collected materials and identify publishable article topics.

Materials:
{chr(10).join(summaries)}

Return JSON array of topics:
[{{"title": "Article title", "tags": ["tag1", "tag2"], "material_count": N, "description": "Brief description"}}]"""

        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=500,
                temperature=0.3,
            )
            text = resp.choices[0].message.content.strip()
            start = text.find("[")
            end = text.rfind("]") + 1
            if start >= 0 and end > start:
                return json.loads(text[start:end])
        except Exception:
            pass
        return []
