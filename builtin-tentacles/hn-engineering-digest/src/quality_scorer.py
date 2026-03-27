"""
QualityScorer — LLM-based engineering relevance scoring.

Uses OpenCeph standard env vars (OPENCEPH_LLM_*) with provider-specific fallback.
All LLM requests are logged to logs/llm_requests.jsonl via LlmLogger.
"""

import json
import logging
import time

import requests

from llm_logger import LlmLogger, resolve_llm_config

log = logging.getLogger(__name__)

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
    """Score HN stories for engineering relevance using the configured LLM provider."""

    def __init__(self, api_key: str = "", base_url: str = "", model: str = ""):
        resolved_key, resolved_url, resolved_model = resolve_llm_config()
        self.api_key = api_key or resolved_key
        self.base_url = (base_url or resolved_url).rstrip("/")
        self.model = model or resolved_model
        if not self.api_key:
            raise ValueError("LLM API key not configured (set OPENCEPH_LLM_API_KEY)")
        self._headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        self._llm_log = LlmLogger()

    def score(self, story: dict, engineering_criteria: str) -> dict:
        prompt = self._build_prompt(story, engineering_criteria)
        messages = [{"role": "user", "content": prompt}]
        start = time.monotonic()
        try:
            resp = requests.post(
                f"{self.base_url}/chat/completions",
                headers=self._headers,
                json={
                    "model": self.model,
                    "messages": messages,
                    "temperature": 0.1,
                    "max_tokens": 256,
                },
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            content = data["choices"][0]["message"]["content"].strip()
            duration_ms = int((time.monotonic() - start) * 1000)

            usage = data.get("usage", {})
            self._llm_log.log_request(
                model=self.model,
                base_url=self.base_url,
                messages=messages,
                temperature=0.1,
                max_tokens=256,
                response_text=content,
                response_message={"role": "assistant", "content": content},
                usage=usage,
                duration_ms=duration_ms,
                success=True,
                extra={"story_id": story.get("objectID"), "story_title": story.get("title", "")[:80]},
            )

            result = json.loads(content)
            return self._validate(result)
        except requests.RequestException as exc:
            duration_ms = int((time.monotonic() - start) * 1000)
            self._llm_log.log_request(
                model=self.model,
                base_url=self.base_url,
                messages=messages,
                temperature=0.1,
                max_tokens=256,
                duration_ms=duration_ms,
                success=False,
                error=str(exc),
                extra={"story_id": story.get("objectID")},
            )
            log.error("LLM request failed for story %s: %s", story.get("objectID"), exc)
        except (KeyError, IndexError, json.JSONDecodeError, ValueError) as exc:
            log.error("Failed to parse LLM response for story %s: %s", story.get("objectID"), exc)
        return self._fallback(story)

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
