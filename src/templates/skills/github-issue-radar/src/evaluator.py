"""
OpenRouter LLM-based issue classification.
"""

import json
import logging
from pathlib import Path

import requests

log = logging.getLogger(__name__)

OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# Load system prompt from file at module level so it fails fast if missing.
_TENTACLE_DIR = Path(__file__).parent.parent
SYSTEM_PROMPT = (_TENTACLE_DIR / "prompt" / "SYSTEM.md").read_text(encoding="utf-8")


class IssueEvaluator:
    def __init__(self, api_key: str, model: str = "openai/gpt-4o-mini"):
        self._api_key = api_key
        self._model = model
        self._session = requests.Session()
        self._session.headers.update({
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })

    def classify(self, issue: dict, focus_areas: str) -> dict:
        """Classify a GitHub issue using the OpenRouter LLM.

        Args:
            issue: Dict with keys: url, title, body, labels, repo, type, author
            focus_areas: User's technical focus areas string

        Returns:
            Dict with keys: relevance (high|medium|low|discard),
                            category (bug|security|feature|other),
                            urgency (immediate|batch|discard),
                            summary (str)
        """
        system_prompt = SYSTEM_PROMPT.replace("{FOCUS_AREAS}", focus_areas)

        user_message = (
            f"Classify the following GitHub {issue.get('type', 'issue')}:\n\n"
            f"Repository: {issue.get('repo', '')}\n"
            f"Title: {issue.get('title', '')}\n"
            f"Author: {issue.get('author', '')}\n"
            f"Labels: {', '.join(issue.get('labels', [])) or 'none'}\n"
            f"URL: {issue.get('url', '')}\n\n"
            f"Body:\n{issue.get('body', '')[:2000]}\n\n"
            "Respond with a JSON object only (no markdown, no explanation) with exactly these keys:\n"
            '  "relevance": "high" | "medium" | "low" | "discard"\n'
            '  "category": "bug" | "security" | "feature" | "other"\n'
            '  "urgency": "immediate" | "batch" | "discard"\n'
            '  "summary": "<one sentence explaining relevance to the user\'s focus areas>"\n'
        )

        payload = {
            "model": self._model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            "temperature": 0.1,
            "max_tokens": 256,
        }

        try:
            response = self._session.post(
                OPENROUTER_API_URL,
                json=payload,
                timeout=30,
            )
            response.raise_for_status()
            data = response.json()
            content = data["choices"][0]["message"]["content"].strip()

            # Strip markdown code fences if present
            if content.startswith("```"):
                lines = content.splitlines()
                content = "\n".join(
                    line for line in lines
                    if not line.startswith("```")
                ).strip()

            result = json.loads(content)

            # Validate and normalise
            relevance = result.get("relevance", "discard")
            if relevance not in ("high", "medium", "low", "discard"):
                relevance = "discard"

            category = result.get("category", "other")
            if category not in ("bug", "security", "feature", "other"):
                category = "other"

            urgency = result.get("urgency", "discard")
            if urgency not in ("immediate", "batch", "discard"):
                urgency = "discard"

            return {
                "relevance": relevance,
                "category": category,
                "urgency": urgency,
                "summary": str(result.get("summary", ""))[:500],
            }

        except (requests.RequestException, KeyError, json.JSONDecodeError) as e:
            log.error(f"IssueEvaluator.classify failed for {issue.get('url', '')}: {e}")
            return {
                "relevance": "discard",
                "category": "other",
                "urgency": "discard",
                "summary": "Classification failed due to API error.",
            }
