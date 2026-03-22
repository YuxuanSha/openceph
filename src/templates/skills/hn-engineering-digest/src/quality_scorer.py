"""
QualityScorer — LLM-based engineering relevance scoring via OpenRouter.

Calls openrouter.ai/api/v1/chat/completions with the configured model.
Returns a structured score dict for each HN story.
"""

import json
import logging

import requests

log = logging.getLogger(__name__)

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

_SCORE_SCHEMA = """\
Respond with a JSON object (no markdown, no explanation) with exactly these keys:
{
  "quality_score": <float 0.0-1.0>,
  "engineering_relevance": <"high" | "medium" | "low">,
  "topics": [<string>, ...],
  "summary": "<one-sentence summary of the engineering content>"
}

Scoring guide:
- 0.9-1.0  Outstanding: novel technique, in-depth architecture, production case study with numbers
- 0.7-0.89 Good: solid technical content, worth reading for an engineer in this area
- 0.5-0.69 Marginal: some technical value but shallow, introductory, or off-topic
- 0.0-0.49 Poor: opinion, news, non-technical, marketing
"""


class QualityScorer:
    """Score HN stories for engineering relevance using an OpenRouter LLM."""

    def __init__(self, api_key: str, model: str = "openai/gpt-4o-mini"):
        if not api_key:
            raise ValueError("OPENROUTER_API_KEY must be set")
        self.api_key = api_key
        self.model = model
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

    def score(self, story: dict, engineering_criteria: str) -> dict:
        """
        Score a single story for engineering quality.

        Args:
            story: normalised story dict from HNClient (must have title, url, score, num_comments).
            engineering_criteria: free-text description of what the user considers a good post.

        Returns:
            dict with keys: quality_score (float), engineering_relevance (str),
            topics (list[str]), summary (str).
            On any error, returns a safe fallback with quality_score=0.0.
        """
        prompt = self._build_prompt(story, engineering_criteria)
        try:
            resp = requests.post(
                OPENROUTER_URL,
                headers=self._headers,
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "max_tokens": 256,
                },
                timeout=30,
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            result = json.loads(content)
            return self._validate(result)
        except requests.RequestException as exc:
            log.error("OpenRouter request failed for story %s: %s", story.get("objectID"), exc)
        except (KeyError, IndexError, json.JSONDecodeError, ValueError) as exc:
            log.error("Failed to parse scorer response for story %s: %s", story.get("objectID"), exc)
        return self._fallback(story)

    # ── Internals ────────────────────────────────────────────────────────────

    def _build_prompt(self, story: dict, engineering_criteria: str) -> str:
        title = story.get("title", "")
        url = story.get("url", "")
        hn_points = story.get("score", 0)
        num_comments = story.get("num_comments", 0)

        return (
            f"You are evaluating a Hacker News story for engineering quality.\n\n"
            f"Engineering criteria the user cares about:\n{engineering_criteria}\n\n"
            f"Story details:\n"
            f"  Title: {title}\n"
            f"  URL: {url}\n"
            f"  HN points: {hn_points}\n"
            f"  Comments: {num_comments}\n\n"
            f"{_SCORE_SCHEMA}"
        )

    def _validate(self, result: dict) -> dict:
        quality_score = float(result.get("quality_score", 0.0))
        quality_score = max(0.0, min(1.0, quality_score))

        engineering_relevance = result.get("engineering_relevance", "low")
        if engineering_relevance not in ("high", "medium", "low"):
            engineering_relevance = "low"

        topics = result.get("topics", [])
        if not isinstance(topics, list):
            topics = []
        topics = [str(t) for t in topics]

        summary = str(result.get("summary", ""))

        return {
            "quality_score": quality_score,
            "engineering_relevance": engineering_relevance,
            "topics": topics,
            "summary": summary,
        }

    def _fallback(self, story: dict) -> dict:
        return {
            "quality_score": 0.0,
            "engineering_relevance": "low",
            "topics": [],
            "summary": f"Scoring unavailable for: {story.get('title', '')}",
        }
