import os
import threading
import time
from pathlib import Path
import json

from db import SeenStore
from filter_engine import filter_items, load_topics, to_consultation_items
from hn_fetcher import fetch_latest_items
from ipc_client import IpcClient, load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(str(BASE_DIR))
RUN_NOW = threading.Event()
PENDING: list[dict] = []


def run_once(store: SeenStore) -> list[dict]:
    topics = load_topics()
    min_score = int(os.environ.get("HN_MIN_SCORE", "50"))
    min_comments = int(os.environ.get("HN_MIN_COMMENTS", "20"))
    use_llm = os.environ.get("USE_LLM_FILTER", "false").lower() == "true"
    llm_criteria = os.environ.get("LLM_FILTER_CRITERIA", "")
    items = fetch_latest_items(topics)
    fresh = [item for item in items if not store.seen(str(item["id"]))]
    filtered = filter_items(fresh, topics, min_score, min_comments, use_llm=use_llm, llm_criteria=llm_criteria)
    for item in fresh:
        store.mark(str(item["id"]))
    return to_consultation_items(filtered[:10])


def flush_pending(ipc: IpcClient, store: SeenStore, findings: list[dict]):
    global PENDING
    batch_size = int(os.environ.get("BATCH_SIZE", "3"))
    urgent = []
    normal = []
    for item in findings:
        reason = item.get("reason", "")
        score = 0
        if "score=" in reason:
            try:
                score = int(reason.split("score=", 1)[1].split(",", 1)[0].strip(") "))
            except Exception:
                score = 0
        if score >= 500:
            urgent.append(item)
        else:
            normal.append(item)

    for item in urgent:
        ipc.consultation_request("batch", [item], "[HN 热帖] 值得立即推送", item.get("sourceUrl", ""))
        store.set_meta("last_report_at", str(time.time()))

    PENDING.extend(normal)
    last_report_at = float(store.get_meta("last_report_at", "0") or "0")
    should_flush = len(PENDING) >= batch_size or (PENDING and (time.time() - last_report_at) >= 24 * 60 * 60)
    if should_flush:
        payload = PENDING[:]
        PENDING = []
        ipc.consultation_request(
            "batch",
            payload,
            f"[HN Radar] 发现 {len(payload)} 条值得关注的帖子",
            json.dumps({"topics": load_topics()}, ensure_ascii=False),
        )
        store.set_meta("last_report_at", str(time.time()))


def main():
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "hn-radar")
    ipc = IpcClient(os.environ["OPENCEPH_SOCKET_PATH"], tentacle_id)
    ipc.connect()
    ipc.register("Monitor Hacker News and report relevant items.", "python")
    store = SeenStore(BASE_DIR / "hn-radar.db")

    def on_directive(payload: dict):
        if payload.get("action") in {"run_now", "set_self_schedule"}:
            RUN_NOW.set()

    ipc.on_directive(on_directive)
    if os.environ.get("OPENCEPH_TRIGGER_MODE", "self") == "self":
        RUN_NOW.set()

    interval = int(os.environ.get("HN_INTERVAL_SECONDS", "7200"))
    while True:
        RUN_NOW.wait(timeout=interval)
        RUN_NOW.clear()
        findings = run_once(store)
        if findings:
            flush_pending(ipc, store, findings)


if __name__ == "__main__":
    main()
