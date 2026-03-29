"""
Filter engine for HN Radar.

Layer 1: Rule-based pre-filtering (optional score/comment thresholds)
Layer 2: LLM-based intelligent filtering (default on, core capability)
"""

import time
import json
from typing import Optional
from openceph_runtime import LlmClient, TentacleLogger
from hn_tools import safe_int


def rule_filter(
    items: list[dict],
    topics: list[str],
    min_score: int = 0,
    min_comments: int = 0,
    log: Optional[TentacleLogger] = None,
) -> list[dict]:
    """Layer 1: Optional rule-based pre-filtering. Default thresholds are 0 (no filtering)."""
    if min_score == 0 and min_comments == 0:
        return items  # No rule filtering — all items go to LLM

    results = []
    for item in items:
        score = safe_int(item.get("score"))
        comments = safe_int(item.get("comments"))

        if score < min_score:
            if log:
                log.daemon("rule_reject", item_id=str(item.get("id", "")),
                           title=str(item.get("title", ""))[:80],
                           reason=f"score:{score}<{min_score}")
            continue
        if comments < min_comments:
            if log:
                log.daemon("rule_reject", item_id=str(item.get("id", "")),
                           title=str(item.get("title", ""))[:80],
                           reason=f"comments:{comments}<{min_comments}")
            continue

        results.append(item)

    if log:
        log.daemon("rule_filter_end", input=len(items), passed=len(results),
                   rejected=len(items) - len(results))
    return results


def llm_filter(
    items: list[dict],
    system_prompt: str,
    llm: LlmClient,
    log: Optional[TentacleLogger] = None,
    batch_size: int = 5,
) -> tuple[list[dict], list[str]]:
    """Layer 2: LLM-based intelligent filtering. Evaluates items in batches."""
    if not items:
        return []

    accepted = []
    rejected_ids = []

    for batch_start in range(0, len(items), batch_size):
        batch = items[batch_start:batch_start + batch_size]

        # Build evaluation prompt
        items_text = ""
        for i, item in enumerate(batch, 1):
            items_text += f"\n{i}. Title: {item.get('title', '(no title)')}\n"
            items_text += f"   Score: {item.get('score', 0)} | Comments: {item.get('comments', 0)}\n"
            if item.get("text"):
                items_text += f"   Preview: {item['text'][:200]}\n"
            if item.get("url"):
                items_text += f"   URL: {item['url']}\n"

        prompt = f"""Evaluate these {len(batch)} Hacker News posts. For each, decide if it's worth pushing to the user.

{items_text}

For each post (in order), output one JSON per line:
{{"accept": true/false, "importance": "high/medium/low", "reason": "one sentence"}}"""

        if log:
            log.agent("llm_filter_batch_start", batch_start=batch_start,
                      batch_size=len(batch), total=len(items))

        t0 = time.time()
        try:
            response = llm.chat([
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ], temperature=0.1, max_tokens=500)

            duration_ms = int((time.time() - t0) * 1000)
            text = response.content or ""

            if log:
                log.agent("llm_filter_batch_end", duration_ms=duration_ms,
                          input_tokens=response.usage.get("prompt_tokens", 0) if response.usage else 0,
                          output_tokens=response.usage.get("completion_tokens", 0) if response.usage else 0,
                          response_preview=text[:300])

            # Parse each line as JSON
            verdicts = _parse_verdicts(text, len(batch))

            for item, verdict in zip(batch, verdicts):
                item_id = str(item.get("id", ""))
                if verdict.get("accept"):
                    item["llm_importance"] = verdict.get("importance", "medium")
                    item["llm_reason"] = verdict.get("reason", "")
                    accepted.append(item)
                    if log:
                        log.agent("llm_verdict", item_id=item_id,
                                  title=item.get("title", "")[:80],
                                  accepted=True, importance=verdict.get("importance"),
                                  reason=verdict.get("reason", ""))
                else:
                    rejected_ids.append(item_id)
                    if log:
                        log.agent("llm_verdict", item_id=item_id,
                                  title=item.get("title", "")[:80],
                                  accepted=False, reason=verdict.get("reason", ""))

        except Exception as e:
            duration_ms = int((time.time() - t0) * 1000)
            if log:
                log.error("llm_filter_batch_error", error=str(e), duration_ms=duration_ms)
            # On LLM error, accept all items in this batch (fail-open)
            accepted.extend(batch)

    if log:
        log.agent("llm_filter_complete", total=len(items),
                  accepted=len(accepted), rejected=len(rejected_ids))

    return accepted, rejected_ids


def _parse_verdicts(text: str, expected_count: int) -> list[dict]:
    """Parse LLM response into verdict dicts. Handles various formats."""
    verdicts = []
    for line in text.strip().split("\n"):
        line = line.strip()
        if not line:
            continue
        # Try to extract JSON from the line
        start = line.find("{")
        end = line.rfind("}") + 1
        if start >= 0 and end > start:
            try:
                verdict = json.loads(line[start:end])
                verdicts.append(verdict)
            except json.JSONDecodeError:
                continue

    # If we got fewer verdicts than items, pad with accept=True (fail-open)
    while len(verdicts) < expected_count:
        verdicts.append({"accept": True, "importance": "medium", "reason": "LLM parse incomplete"})

    return verdicts[:expected_count]


def to_consultation_items(items: list[dict]) -> list[dict]:
    """Convert filtered items to consultation format."""
    findings = []
    for item in items:
        findings.append({
            "id": str(item.get("id", "")),
            "title": item.get("title", ""),
            "content": (
                f"📰 {item.get('title', '')}\n"
                f"{item.get('score', 0)}分 · {item.get('comments', 0)}条评论\n"
                f"链接：{item.get('url', '')}\n"
                f"HN 讨论：{item.get('comments_url', '')}"
            ),
            "score": safe_int(item.get("score")),
            "importance": item.get("llm_importance", "medium"),
            "reason": item.get("llm_reason") or f"score={item.get('score', 0)}, comments={item.get('comments', 0)}",
            "sourceUrl": item.get("url"),
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
    return findings
