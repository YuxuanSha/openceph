import os
import threading
import time
from pathlib import Path

from db import PriceStore
from extractor import fetch_price_for_watch, load_watch_items
from ipc_client import IpcClient, load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(str(BASE_DIR))
RUN_NOW = threading.Event()


def build_items(store: PriceStore) -> list[dict]:
    items = []
    for watch in load_watch_items(os.environ.get("WATCH_ITEMS_JSON", "[]")):
        name = watch.get("name") or watch.get("url")
        price = fetch_price_for_watch(watch)
        if price is None:
            continue
        previous = store.get(name)
        store.set(name, price)
        if previous is None or previous == price:
            continue
        direction = "降" if price < previous else "涨"
        change_pct = ((price - previous) / previous * 100) if previous else 0
        alert_on = (watch.get("alert_on") or "change").lower()
        target_price = watch.get("target_price")
        should_alert = alert_on == "change"
        if alert_on == "drop":
            should_alert = price < previous
        elif alert_on == "target":
            should_alert = target_price is not None and price <= float(target_price)
        if not should_alert:
            continue
        items.append({
            "id": name,
            "content": f"💰 价格变动提醒\n{name}：{previous} → {price}（{direction}价 {abs(change_pct):.1f}%）\n来源：{watch['url']}",
            "tentacleJudgment": "important" if price < previous else "reference",
            "reason": f"Detected price event ({alert_on}) against stored baseline.",
            "sourceUrl": watch["url"],
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
    return items


def main():
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "price-alert-monitor")
    ipc = IpcClient(os.environ["OPENCEPH_SOCKET_PATH"], tentacle_id)
    ipc.connect()
    ipc.register("Monitor configured targets for price changes.", "python")
    store = PriceStore(BASE_DIR / "price-alert-monitor.db")

    def on_directive(payload: dict):
        if payload.get("action") in {"run_now", "set_self_schedule"}:
            RUN_NOW.set()

    ipc.on_directive(on_directive)
    if os.environ.get("OPENCEPH_TRIGGER_MODE", "self") == "self":
        RUN_NOW.set()

    interval = int(os.environ.get("PRICE_INTERVAL_SECONDS", "21600"))
    while True:
        RUN_NOW.wait(timeout=interval)
        RUN_NOW.clear()
        items = build_items(store)
        if items:
            ipc.consultation_request("batch", items, f"Price monitor detected {len(items)} changes.", "price_alerts")


if __name__ == "__main__":
    main()
