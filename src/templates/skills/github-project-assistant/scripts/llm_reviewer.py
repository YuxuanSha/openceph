"""
LLM-powered issue classification and PR review.
Uses OpenRouter API (OpenAI-compatible).
"""

import json
from openai import OpenAI


class LLMReviewer:
    def __init__(self, api_key: str, model: str = "anthropic/claude-haiku-4-5"):
        self.client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=api_key,
        ) if api_key else None
        self.model = model

    def classify_issue(self, issue: dict) -> dict:
        """Classify an issue into category and priority."""
        if not self.client:
            return {"category": "unknown", "priority": "normal", "reason": "No LLM available"}

        prompt = f"""Classify this GitHub issue.

Title: {issue['title']}
Body: {issue.get('body', '')[:1000]}
Labels: {', '.join(issue.get('labels', []))}

Respond in JSON:
{{"category": "bug|feature|question|docs", "priority": "high|normal|low", "reason": "brief explanation"}}"""

        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=200,
                temperature=0.1,
            )
            text = resp.choices[0].message.content.strip()
            # Extract JSON from response
            start = text.find("{")
            end = text.rfind("}") + 1
            if start >= 0 and end > start:
                return json.loads(text[start:end])
        except Exception as e:
            return {"category": "unknown", "priority": "normal", "reason": str(e)}

        return {"category": "unknown", "priority": "normal", "reason": "Parse error"}

    def review_pr(self, pr: dict) -> str:
        """Generate a review summary for a PR."""
        if not self.client:
            return f"PR #{pr['number']}: {pr['title']} (no LLM available for review)"

        prompt = f"""Review this GitHub PR diff and provide a concise summary.
Focus on: security implications, performance impact, architecture changes.

Title: {pr['title']}
Description: {pr.get('body', '')[:500]}
Diff (truncated):
{pr.get('diff', '')[:3000]}

Provide a 2-3 sentence review summary."""

        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=300,
                temperature=0.2,
            )
            return resp.choices[0].message.content.strip()
        except Exception as e:
            return f"Review failed: {e}"
