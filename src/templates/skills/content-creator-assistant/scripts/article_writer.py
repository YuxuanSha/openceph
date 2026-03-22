"""
LLM-powered article generation and revision.
"""

from openai import OpenAI


class ArticleWriter:
    def __init__(self, api_key: str, model: str = "anthropic/claude-sonnet-4-5"):
        self.client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key,
        ) if api_key else None
        self.model = model

    def generate_draft(self, title: str, materials: list[dict]) -> str:
        """Generate an article draft from materials."""
        if not self.client:
            return f"# {title}\n\n(Draft generation requires LLM API key)"

        material_texts = []
        for m in materials[:20]:
            material_texts.append(f"- {m['content'][:300]}")

        prompt = f"""Write a well-structured article based on these collected materials.

Title: {title}
Materials:
{chr(10).join(material_texts)}

Requirements:
- Write in the same language as the materials (Chinese if materials are in Chinese)
- 1500-2500 words
- Clear structure with introduction, body sections, and conclusion
- Reference specific materials as supporting evidence
- Professional but accessible tone"""

        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=4000,
                temperature=0.5,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            return f"# {title}\n\nDraft generation failed: {e}"

    def revise_draft(self, current_draft: str, feedback: str) -> str:
        """Revise a draft based on user feedback."""
        if not self.client:
            return current_draft

        prompt = f"""Revise this article based on user feedback.

Current draft:
{current_draft}

User feedback:
{feedback}

Rewrite the article incorporating the feedback. Keep the same general structure unless the feedback requires restructuring."""

        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=4000,
                temperature=0.4,
            )
            return resp.choices[0].message.content.strip()
        except Exception:
            return current_draft
