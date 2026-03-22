import os
import threading
import time
from pathlib import Path

from curator import build_digest, load_items
from ipc_client import IpcClient, load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(str(BASE_DIR))
RUN_NOW = threading.Event()


def main():
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "daily-digest-curator")
    ipc = IpcClient(os.environ["OPENCEPH_SOCKET_PATH"], tentacle_id)
    ipc.connect()
    ipc.register("Curate pending findings into a daily digest.", "python")

    def on_directive(payload: dict):
        if payload.get("action") in {"run_now", "set_self_schedule"}:
            RUN_NOW.set()

    ipc.on_directive(on_directive)
    if os.environ.get("OPENCEPH_TRIGGER_MODE", "external") == "self":
        RUN_NOW.set()

    while True:
        RUN_NOW.wait(timeout=3600)
        RUN_NOW.clear()
        digest = build_digest(load_items(), os.environ.get("DIGEST_STYLE", "concise"))
        if digest:
            ipc.consultation_request("batch", [{
                "id": "daily-digest",
                "content": digest,
                "tentacleJudgment": "important",
                "reason": "Daily digest ready for delivery.",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }], "Daily digest curated.", os.environ.get("DIGEST_STYLE", "concise"))


if __name__ == "__main__":
    main()
