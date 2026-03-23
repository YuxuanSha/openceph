import os
import signal
import threading
import time
import json
import sys
import traceback
from pathlib import Path

from arxiv_client import fetch_entries
from db import PaperStore
from ipc_client import IpcClient, load_dotenv
import requests


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(str(BASE_DIR))
RUN_NOW = threading.Event()
PAUSED = threading.Event()
SHUTDOWN = threading.Event()
INTERVAL_SECONDS = 12 * 60 * 60


def log(message: str) -> None:
    sys.stderr.write(f"[arxiv-paper-scout] {message}\n")
    sys.stderr.flush()


def parse_interval_seconds(raw: str | None, default_seconds: int) -> int:
    if not raw:
        return default_seconds
    value = str(raw).strip().lower().replace("every ", "")
    if not value:
        return default_seconds
    if value.isdigit():
        return max(1, int(value))

    units = {
        "ms": 0.001,
        "millisecond": 0.001,
        "milliseconds": 0.001,
        "s": 1,
        "sec": 1,
        "secs": 1,
        "second": 1,
        "seconds": 1,
        "m": 60,
        "min": 60,
        "mins": 60,
        "minute": 60,
        "minutes": 60,
        "h": 3600,
        "hr": 3600,
        "hrs": 3600,
        "hour": 3600,
        "hours": 3600,
        "d": 86400,
        "day": 86400,
        "days": 86400,
        "w": 604800,
        "week": 604800,
        "weeks": 604800,
    }
    for unit, multiplier in units.items():
        if value.endswith(unit):
            number = value[:-len(unit)].strip()
            if not number:
                continue
            return max(1, int(float(number) * multiplier))
    raise ValueError(f"Unsupported interval: {raw}")


def _llm_review(entry: dict) -> tuple[bool, str, str]:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        return True, entry["summary"][:260], "匹配用户关注关键词，建议进一步查看。"

    prompt = f"""Read this arXiv paper metadata and decide whether it is worth recommending.

Quality bar:
{os.environ.get("QUALITY_CRITERIA", "Prefer methodological novelty, strong engineering relevance, reproducibility, and clear empirical gains.")}

Title: {entry['title']}
Summary: {entry['summary']}

Return JSON:
{{"accept": true|false, "summary": "2 sentence Chinese summary", "highlight": "Why it matters"}}"""
    try:
        response = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": os.environ.get("OPENROUTER_MODEL", "anthropic/claude-haiku-4-5"),
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.1,
                "max_tokens": 220,
            },
            timeout=30,
        )
        response.raise_for_status()
        data = response.json()
        text = (((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
        start = text.find("{")
        end = text.rfind("}") + 1
        if start >= 0 and end > start:
            data = json.loads(text[start:end])
            return bool(data.get("accept", True)), data.get("summary", entry["summary"][:260]), data.get("highlight", "值得进一步阅读。")
    except Exception as exc:
        log(f"LLM review failed for {entry.get('id', 'unknown')}: {exc}")
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


def build_summary_item(scan_count: int, findings_count: int, error: str | None = None) -> dict:
    content = (
        f"[arXiv 扫描摘要]\n\n"
        f"扫描论文：{scan_count}\n"
        f"高优先级论文：{findings_count}\n"
        f"结果：{'本轮无高分论文' if findings_count == 0 else '已发现值得进一步查看的论文'}"
    )
    if error:
        content += f"\n异常：{error}"
    return {
        "id": f"summary-{int(time.time())}",
        "content": content,
        "tentacleJudgment": "reference",
        "reason": "Always report the result of each arXiv polling cycle.",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def main():
    global INTERVAL_SECONDS
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "arxiv-paper-scout")
    ipc = IpcClient(tentacle_id)
    ipc.connect()
    ipc.register("Monitor arXiv feeds and report selected papers.", "python")
    store = PaperStore(BASE_DIR / "arxiv-paper-scout.db")
    INTERVAL_SECONDS = parse_interval_seconds(
        os.environ.get("OPENCEPH_SELF_INTERVAL_SECONDS") or os.environ.get("ARXIV_INTERVAL_SECONDS"),
        43200,
    )

    signal.signal(signal.SIGTERM, lambda *_: (SHUTDOWN.set(), RUN_NOW.set()))
    signal.signal(signal.SIGINT, lambda *_: (SHUTDOWN.set(), RUN_NOW.set()))

    def on_directive(payload: dict):
        global INTERVAL_SECONDS
        action = payload.get("action")
        if action == "pause":
            PAUSED.set()
            log("directive pause received")
            return
        if action == "resume":
            PAUSED.clear()
            RUN_NOW.set()
            log("directive resume received")
            return
        if action == "kill":
            SHUTDOWN.set()
            RUN_NOW.set()
            log("directive kill received")
            return
        if action in {"run_now", "set_self_schedule"}:
            if action == "set_self_schedule":
                try:
                    INTERVAL_SECONDS = parse_interval_seconds(payload.get("interval"), INTERVAL_SECONDS)
                    log(f"self schedule updated to {INTERVAL_SECONDS}s")
                except Exception as exc:
                    log(f"failed to update interval from payload {payload!r}: {exc}")
            RUN_NOW.set()

    ipc.on_directive(on_directive)
    if os.environ.get("OPENCEPH_TRIGGER_MODE", "self") == "self":
        RUN_NOW.set()

    log(f"starting tentacle_id={tentacle_id} trigger_mode={os.environ.get('OPENCEPH_TRIGGER_MODE', 'self')} interval={INTERVAL_SECONDS}s")
    while not SHUTDOWN.is_set():
        RUN_NOW.wait(timeout=INTERVAL_SECONDS)
        RUN_NOW.clear()
        if SHUTDOWN.is_set():
            break
        if PAUSED.is_set():
            continue
        try:
            items = build_items(store)
            summary = build_summary_item(scan_count=len(items), findings_count=len(items))
            payload = [*items, summary]
            ipc.consultation_request("batch", payload, f"arXiv scout finished a scan with {len(items)} findings.", os.environ.get("ARXIV_KEYWORDS", ""))
            log(f"scan completed findings={len(items)}")
        except Exception as exc:
            error_text = f"{type(exc).__name__}: {exc}"
            log(f"scan failed: {error_text}")
            log(traceback.format_exc())
            ipc.consultation_request(
                "batch",
                [build_summary_item(scan_count=0, findings_count=0, error=error_text)],
                "arXiv scout scan failed.",
                os.environ.get("ARXIV_KEYWORDS", ""),
            )

    ipc.close()
    log("tentacle exited")


if __name__ == "__main__":
    main()
