import json
import os
import threading
import time
import urllib.request
from pathlib import Path

from db import UptimeStore
from ipc_client import IpcClient, load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(str(BASE_DIR))
RUN_NOW = threading.Event()


def load_endpoints() -> list[dict]:
    try:
        return json.loads(os.environ.get("WATCH_ENDPOINTS", "[]"))
    except Exception:
        return []


def check_endpoint(endpoint: dict) -> tuple[str, float, str]:
    timeout = int(endpoint.get("timeout") or 10)
    started = time.time()
    try:
        with urllib.request.urlopen(endpoint["url"], timeout=timeout) as response:
            latency = (time.time() - started) * 1000
            status = f"up:{response.status}"
            if response.status >= 400:
                return "down", latency, f"HTTP {response.status}"
            return "up", latency, f"HTTP {response.status}"
    except Exception as exc:
        latency = (time.time() - started) * 1000
        return "down", latency, str(exc)


def build_items(store: UptimeStore) -> list[dict]:
    findings = []
    for endpoint in load_endpoints():
        name = endpoint.get("name") or endpoint["url"]
        status, latency, detail = check_endpoint(endpoint)
        previous = store.get(name)
        now_text = time.strftime("%Y-%m-%d %H:%M:%S")
        baseline = float(endpoint.get("baseline_latency_ms") or (previous or {}).get("latency_ms") or 0)
        is_slow = baseline > 0 and latency > baseline * 3
        slow_streak = ((previous or {}).get("slow_streak") or 0) + 1 if is_slow else 0
        first_failure_at = (previous or {}).get("first_failure_at")
        if status == "down":
            first_failure_at = first_failure_at or now_text
        else:
            first_failure_at = None
        last_ok_at = now_text if status == "up" else (previous or {}).get("last_ok_at")
        store.set(name, status, latency, last_ok_at, first_failure_at, slow_streak)
        if status == "down":
            findings.append({
                "id": name,
                "content": (
                    f"🚨 [DOWN] {name} 不可达！\n"
                    f"URL：{endpoint['url']}\n"
                    f"状态：{detail}\n"
                    f"持续时间：{_duration_text(first_failure_at, now_text)}\n"
                    f"最后正常：{(previous or {}).get('last_ok_at') or 'unknown'}"
                ),
                "tentacleJudgment": "important",
                "reason": "Endpoint is failing and should be pushed immediately.",
                "sourceUrl": endpoint["url"],
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
        elif slow_streak >= 2:
            findings.append({
                "id": f"{name}:slow",
                "content": (
                    f"⚠️ [SLOW] {name} 响应变慢。\n"
                    f"URL：{endpoint['url']}\n"
                    f"响应时间：{latency:.0f}ms\n"
                    f"基线：{baseline:.0f}ms\n"
                    f"连续慢响应：{slow_streak} 次"
                ),
                "tentacleJudgment": "reference",
                "reason": "Endpoint latency exceeded baseline repeatedly.",
                "sourceUrl": endpoint["url"],
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
        elif previous and previous["status"] == "down" and status == "up":
            findings.append({
                "id": f"{name}:recovered",
                "content": f"✅ [RECOVERED] {name} 已恢复正常。\nURL：{endpoint['url']}\n响应时间：{latency:.0f}ms",
                "tentacleJudgment": "reference",
                "reason": "Previously failing endpoint recovered.",
                "sourceUrl": endpoint["url"],
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
    return findings


def _duration_text(started_at: str | None, now_text: str) -> str:
    if not started_at:
        return "刚刚发生"
    return f"{started_at} -> {now_text}"


def main():
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "uptime-watchdog")
    ipc = IpcClient(os.environ["OPENCEPH_SOCKET_PATH"], tentacle_id)
    ipc.connect()
    ipc.register("Monitor websites and APIs for downtime and latency regressions.", "python")
    store = UptimeStore(BASE_DIR / "uptime-watchdog.db")

    def on_directive(payload: dict):
        if payload.get("action") in {"run_now", "set_self_schedule"}:
            RUN_NOW.set()

    ipc.on_directive(on_directive)
    if os.environ.get("OPENCEPH_TRIGGER_MODE", "self") == "self":
        RUN_NOW.set()

    interval = int(os.environ.get("CHECK_INTERVAL_SECONDS", "300"))
    while True:
        RUN_NOW.wait(timeout=interval)
        RUN_NOW.clear()
        items = build_items(store)
        if items:
            ipc.consultation_request("batch", items, f"Uptime watchdog generated {len(items)} status changes.", "uptime_watch")


if __name__ == "__main__":
    main()
