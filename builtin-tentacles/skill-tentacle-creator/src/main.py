import os
import threading
import time
from pathlib import Path

from creator import scaffold_tentacle
from validator import validate_skill_tentacle
from packager import package_tentacle
from ipc_client import IpcClient, load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(str(BASE_DIR))

RUN_NOW = threading.Event()


def build_report(name: str, purpose: str) -> dict:
    output_root = Path(os.environ.get("CREATOR_OUTPUT_DIR", BASE_DIR / "generated-tentacles"))
    output_root.mkdir(parents=True, exist_ok=True)
    generated = scaffold_tentacle(output_root, name, purpose)
    errors = validate_skill_tentacle(generated)
    archive = package_tentacle(generated)
    if errors:
        content = f"🛠️ 触手脚手架已生成，但校验失败：{'; '.join(errors)}"
        judgment = "important"
    else:
        content = f"🛠️ 已生成触手脚手架 `{name}`，路径：{generated}\n打包文件：{archive}"
        judgment = "reference"
    return {
        "id": name,
        "content": content,
        "tentacleJudgment": judgment,
        "reason": purpose,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def main():
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "skill-tentacle-creator")
    socket_path = os.environ["OPENCEPH_SOCKET_PATH"]
    ipc = IpcClient(socket_path, tentacle_id)
    ipc.connect()
    ipc.register("Create and validate new skill_tentacle packages", "python")

    def on_directive(payload: dict):
        action = payload.get("action")
        if action == "run_now" or action == "consultation_followup":
            RUN_NOW.set()

    ipc.on_directive(on_directive)
    if os.environ.get("OPENCEPH_TRIGGER_MODE", "external") == "self":
        RUN_NOW.set()

    while True:
        RUN_NOW.wait()
        RUN_NOW.clear()
        name = os.environ.get("CREATOR_TENTACLE_NAME", "generated-monitor")
        purpose = os.environ.get("CREATOR_PURPOSE", "Monitor a custom source and report useful findings.")
        item = build_report(name, purpose)
        ipc.consultation_request("batch", [item], "Generated a new skill_tentacle scaffold.", "creator_run")


if __name__ == "__main__":
    main()
