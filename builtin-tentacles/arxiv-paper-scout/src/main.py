import os
import threading
import time
import json
from pathlib import Path

from arxiv_client import fetch_entries
from db import PaperStore
from ipc_client import IpcClient, load_dotenv
from openai import OpenAI


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(str(BASE_DIR))
RUN_NOW = threading.Event()


def _llm_review(entry: dict) -> tuple[bool, str, str]:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        return True, entry["summary"][:260], "匹配用户关注关键词，建议进一步查看。"

    client = OpenAI(base_url="https://openrouter.ai/api/v1", api_key=api_key)
    prompt = f"""Read this arXiv paper metadata and decide whether it is worth recommending.

Quality bar:
{os.environ.get("QUALITY_CRITERIA", "Prefer methodological novelty, strong engineering relevance, reproducibility, and clear empirical gains.")}

Title: {entry['title']}
Summary: {entry['summary']}

Return JSON:
{{"accept": true|false, "summary": "2 sentence Chinese summary", "highlight": "Why it matters"}}"""
    try:
        response = client.chat.completions.create(
            model=os.environ.get("OPENROUTER_MODEL", "anthropic/claude-haiku-4-5"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=220,
        )
        text = response.choices[0].message.content.strip()
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            data = json.loads(text[start:end])
            return bool(data.get("accept", True)), data.get("summary", entry["summary"][:260]), data.get("highlight", "值得进一步阅读。")
    except Exception:
        pass
    return True, entry["summary"][:260], "匹配用户关注关键词，建议进一步查看。"


def build_items(store: PaperStore) -> list[dict]:
    categories = [item.strip() for item in os.environ.get("ARXIV_CATEGORIES", "cs.AI,cs.CL,cs.MA").split(",") if item.strip()]
    keywords = [item.strip().lower() for item in os.environ.get("ARXIV_KEYWORDS", "agent,multi-agent,LLM,reasoning").split(",") if item.strip()]
    findings = []
    for entry in fetch_entries(categories):
        if store.seen(entry["id"]):
            continue
        store.mark(entry["id"])
        haystack = f"{entry['title']} {entry['summary']}".lower()
        if keywords and not any(keyword in haystack for keyword in keywords):
            continue
        accepted, summary, highlight = _llm_review(entry)
        if not accepted:
            continue
        findings.append({
            "id": entry["id"],
            "content": (
                f"[arXiv 精选]\n\n🎓 {entry['title']}\n"
                f"摘要：{summary}\n"
                f"亮点：{highlight}\n"
                f"链接：{entry['id']}"
            ),
            "tentacleJudgment": "important",
            "reason": "Paper matched arXiv categories and configured keywords.",
            "sourceUrl": entry["id"],
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
    return findings[:5]


def main():
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "arxiv-paper-scout")
    ipc = IpcClient(os.environ["OPENCEPH_SOCKET_PATH"], tentacle_id)
    ipc.connect()
    ipc.register("Monitor arXiv feeds and report selected papers.", "python")
    store = PaperStore(BASE_DIR / "arxiv-paper-scout.db")

    def on_directive(payload: dict):
        if payload.get("action") in {"run_now", "set_self_schedule"}:
            RUN_NOW.set()

    ipc.on_directive(on_directive)
    if os.environ.get("OPENCEPH_TRIGGER_MODE", "self") == "self":
        RUN_NOW.set()

    interval = int(os.environ.get("ARXIV_INTERVAL_SECONDS", "43200"))
    while True:
        RUN_NOW.wait(timeout=interval)
        RUN_NOW.clear()
        items = build_items(store)
        if items:
            ipc.consultation_request("batch", items, f"arXiv scout selected {len(items)} papers.", os.environ.get("ARXIV_KEYWORDS", ""))


if __name__ == "__main__":
    main()
