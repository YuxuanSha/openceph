import os
import time
import json
from openai import OpenAI


def load_topics() -> list[str]:
    return [item.strip() for item in os.environ.get("HN_TOPICS", "AI,LLM,agent,startup").split(",") if item.strip()]


def filter_items(
    items: list[dict],
    topics: list[str],
    min_score: int,
    min_comments: int,
    use_llm: bool = False,
    llm_criteria: str = "",
) -> list[dict]:
    results = []
    lowered_topics = [topic.lower() for topic in topics]
    for item in items:
        haystack = f"{item.get('title', '')}\n{item.get('text', '')}".lower()
        if lowered_topics and not any(topic in haystack for topic in lowered_topics):
            continue
        if int(item.get("score") or 0) < min_score:
            continue
        if int(item.get("comments") or 0) < min_comments:
            continue
        if use_llm and not _llm_accept(item, llm_criteria):
            continue
        results.append(item)
    return results


def to_consultation_items(items: list[dict]) -> list[dict]:
    findings = []
    for item in items:
        findings.append({
            "id": str(item["id"]),
            "content": (
                f"📡 [HN Radar]\n\n📰 {item['title']}\n"
                f"{item.get('score', 0)}分 · {item.get('comments', 0)}条评论\n"
                f"链接：{item.get('url')}\nHN 讨论：{item.get('comments_url')}"
            ),
            "tentacleJudgment": "important" if int(item.get("score") or 0) >= 150 else "reference",
            "reason": f"Matched topic and engagement thresholds (score={item.get('score', 0)}, comments={item.get('comments', 0)})",
            "sourceUrl": item.get("url"),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
    return findings


def _llm_accept(item: dict, criteria: str) -> bool:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        return True

    client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=api_key)
    prompt = f"""Decide whether this Hacker News post is worth pushing to the user.

Criteria:
{criteria or 'Prioritize concrete engineering lessons, real system design, and non-trivial technical insights.'}

Title: {item.get('title', '')}
Score: {item.get('score', 0)}
Comments: {item.get('comments', 0)}
Text: {item.get('text', '')[:800]}

Respond as JSON: {{"accept": true|false, "reason": "short reason"}}"""
    try:
        response = client.chat.completions.create(
            model=os.environ.get("OPENROUTER_MODEL", "anthropic/claude-haiku-4-5"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=120,
        )
        text = response.choices[0].message.content.strip()
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            data = json.loads(text[start:end])
            return bool(data.get("accept"))
    except Exception:
        return True
    return True
