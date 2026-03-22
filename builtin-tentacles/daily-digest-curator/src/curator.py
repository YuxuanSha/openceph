import json
import os
import re
import time
from pathlib import Path


def load_items() -> list[dict]:
    items = []
    env_items = _load_json_items(os.environ.get("DIGEST_INPUT_JSON", "[]"))
    if env_items:
        items.extend(env_items)

    state_dir = Path(os.environ.get("OPENCEPH_STATE_DIR", "~/.openceph/state")).expanduser()
    items.extend(_load_pending_reports(state_dir / "pending-reports.json"))
    items.extend(_load_outbound_queue(state_dir / "outbound-queue.json"))
    return _deduplicate(items)


def build_digest(items: list[dict], style: str = "简洁高密度，每条一句话摘要 + 链接") -> str:
    curated = _sort_items(items)[:10]
    if not curated:
        return ""

    grouped: dict[str, list[dict]] = {
        "技术动态": [],
        "开源更新": [],
        "研究论文": [],
        "价格与监控": [],
        "其他": [],
    }
    for item in curated:
        grouped[_classify_topic(item)].append(item)

    lines = [f"☀️ 今日简报（{time.strftime('%Y-%m-%d')}）", f"风格：{style}", ""]
    for topic, topic_items in grouped.items():
        if not topic_items:
            continue
        lines.append(f"📌 {topic}（{len(topic_items)}条）")
        for index, item in enumerate(topic_items, start=1):
            summary = _summarize_item(item)
            suffix = f" — {item.get('tentacleId', 'system')}"
            link = item.get("sourceUrl")
            lines.append(f"{index}. {summary}{suffix}")
            if link:
                lines.append(f"   链接：{link}")
        lines.append("")

    lines.append(f"共整合 {len(curated)} 条信息，来自 {len({item.get('tentacleId', 'system') for item in curated})} 个触手。")
    return "\n".join(lines).strip()


def _load_json_items(raw: str) -> list[dict]:
    try:
        data = json.loads(raw or "[]")
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _load_pending_reports(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []

    items = []
    for report in raw:
        if report.get("status") != "pending":
            continue
        items.append({
            "summary": report.get("summary") or report.get("findingId"),
            "content": report.get("summary") or report.get("findingId"),
            "tentacleId": report.get("tentacleId", "unknown"),
            "priority": "important" if float(report.get("confidence") or 0) >= 0.8 else "reference",
            "sourceUrl": report.get("sourceUrl"),
        })
    return items


def _load_outbound_queue(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []

    items = []
    for entry in raw:
        if entry.get("status") != "pending":
            continue
        if entry.get("kind") == "deferred_message":
            items.append({
                "summary": entry.get("message"),
                "content": entry.get("message"),
                "tentacleId": entry.get("tentacleId", entry.get("source", "unknown")),
                "priority": entry.get("priority", "normal"),
                "sourceUrl": entry.get("sourceUrl"),
            })
        else:
            items.append({
                "summary": entry.get("content"),
                "content": entry.get("content"),
                "tentacleId": entry.get("tentacleId", "unknown"),
                "priority": entry.get("priority", "normal"),
                "sourceUrl": entry.get("sourceUrl"),
            })
    return items


def _deduplicate(items: list[dict]) -> list[dict]:
    seen = set()
    result = []
    for item in items:
        text = _normalize(item.get("summary") or item.get("content") or "")
        key = item.get("sourceUrl") or text[:120]
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def _sort_items(items: list[dict]) -> list[dict]:
    weight = {"urgent": 0, "important": 1, "high": 1, "normal": 2, "reference": 3, "low": 4}
    return sorted(items, key=lambda item: (weight.get(str(item.get("priority", "normal")).lower(), 2), item.get("tentacleId", "")))


def _classify_topic(item: dict) -> str:
    text = _normalize(f"{item.get('tentacleId', '')} {item.get('summary') or item.get('content') or ''}")
    if any(keyword in text for keyword in ["release", "github", "tag", "version", "changelog"]):
        return "开源更新"
    if any(keyword in text for keyword in ["arxiv", "paper", "论文", "research"]):
        return "研究论文"
    if any(keyword in text for keyword in ["price", "价格", "uptime", "down", "latency", "监控"]):
        return "价格与监控"
    if any(keyword in text for keyword in ["hn", "hacker news", "mcp", "agent", "开源", "技术"]):
        return "技术动态"
    return "其他"


def _summarize_item(item: dict) -> str:
    text = item.get("summary") or item.get("content") or ""
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= 140:
        return text
    return text[:137].rstrip() + "..."


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()
