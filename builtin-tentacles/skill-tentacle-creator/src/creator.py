import os
import re
from pathlib import Path


def scaffold_tentacle(output_dir: Path, name: str, purpose: str) -> Path:
    target = output_dir / name
    (target / "prompt").mkdir(parents=True, exist_ok=True)
    (target / "src").mkdir(parents=True, exist_ok=True)

    trigger = os.environ.get("CREATOR_TRIGGER", "every 6 hours")
    needs_llm = os.environ.get("CREATOR_NEEDS_LLM", "false").lower() == "true"
    needs_database = os.environ.get("CREATOR_NEEDS_DATABASE", "false").lower() == "true"
    runtime = os.environ.get("CREATOR_RUNTIME", "python")
    keywords = [item.strip() for item in os.environ.get("CREATOR_KEYWORDS", "").split(",") if item.strip()]
    env_vars = [item.strip() for item in os.environ.get("CREATOR_ENV_VARS", "").split(",") if item.strip()]
    if needs_llm and "OPENROUTER_API_KEY" not in env_vars:
        env_vars.append("OPENROUTER_API_KEY")

    capabilities = ["content_generation"]
    if needs_database:
        capabilities.append("database")
    if needs_llm:
        capabilities.append("llm_reasoning")

    (target / "SKILL.md").write_text(
        _render_skill_md(name, purpose, trigger, runtime, env_vars, capabilities, needs_llm, needs_database),
        encoding="utf-8",
    )
    (target / "README.md").write_text(
        _render_readme(name, purpose, env_vars, keywords),
        encoding="utf-8",
    )
    (target / "prompt" / "SYSTEM.md").write_text(
        _render_system_prompt(name, purpose, keywords),
        encoding="utf-8",
    )
    (target / "src" / "main.py").write_text(
        _render_main_py(name, purpose, keywords),
        encoding="utf-8",
    )
    (target / "src" / "requirements.txt").write_text(
        "python-dotenv==1.0.0\n",
        encoding="utf-8",
    )
    (target / "src" / "ipc_client.py").write_text(
        (Path(__file__).with_name("ipc_client.py")).read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    return target


def _slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-") or "generated-tentacle"


def _render_skill_md(
    name: str,
    purpose: str,
    trigger: str,
    runtime: str,
    env_vars: list[str],
    capabilities: list[str],
    needs_llm: bool,
    needs_database: bool,
) -> str:
    return f"""---
name: {name}
description: {purpose}
version: 1.0.0
metadata:
  openceph:
    trigger_keywords: ["{name}", "{_slug(name)}"]
    tentacle:
      spawnable: true
      runtime: {runtime}
      entry: src/main.py
      default_trigger: "{trigger}"
      setup_commands:
        - "python3 -m venv venv"
        - "venv/bin/pip install -r src/requirements.txt"
      requires:
        bins: ["python3"]
        env: {env_vars}
      capabilities: {capabilities}
      infrastructure:
        needsLlm: {str(needs_llm).lower()}
        needsDatabase: {str(needs_database).lower()}
---
# {name}

{purpose}
"""


def _render_readme(name: str, purpose: str, env_vars: list[str], keywords: list[str]) -> str:
    env_lines = "\n".join(f"- `{var}`" for var in env_vars) if env_vars else "- 无额外环境变量"
    keyword_lines = ", ".join(keywords) if keywords else "按需补充"
    return f"""# {name}

## 使命
{purpose}

## 建议关注关键词
{keyword_lines}

## 环境变量
{env_lines}

## 部署步骤
1. `python3 -m venv venv`
2. `venv/bin/pip install -r src/requirements.txt`
3. 由 OpenCeph 注入 `.env` 后运行 `src/main.py`

## 启动命令
`venv/bin/python src/main.py`

## 说明
这是由 `skill-tentacle-creator` 生成的可运行起点，已包含标准 IPC 注册、run_now 触发和 consultation_request 上报逻辑。
"""


def _render_system_prompt(name: str, purpose: str, keywords: list[str]) -> str:
    keyword_lines = "\n".join(f"- {item}" for item in keywords) if keywords else "- 按需填写"
    return f"""# 你是 {name}

## 使命
{purpose}

## 关注重点
{keyword_lines}

## 行为约束
- 发现值得用户知道的信息后，通过 consultation_request 上报给大脑
- 不直接联系用户
- 优先输出高信噪比信息，避免噪声
"""


def _render_main_py(name: str, purpose: str, keywords: list[str]) -> str:
    keyword_list = ", ".join(keywords) if keywords else "general"
    return f"""import os
import threading
import time
from pathlib import Path

from ipc_client import IpcClient, load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(str(BASE_DIR))
RUN_NOW = threading.Event()


def collect_findings() -> list[dict]:
    keywords = [item.strip() for item in os.environ.get("GENERATED_KEYWORDS", "{keyword_list}").split(",") if item.strip()]
    summary = os.environ.get("GENERATED_SUMMARY", "{purpose}")
    if not summary:
        return []
    lines = [f"📌 {{summary}}", "", "关注点："]
    for keyword in keywords:
        lines.append(f"- {{keyword}}")
    return [{{
        "id": os.environ.get("GENERATED_FINDING_ID", "{_slug(name)}-sample"),
        "content": "\\n".join(lines),
        "tentacleJudgment": "reference",
        "reason": "Generated scaffold ready for customization.",
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }}]


def main():
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "{name}")
    socket_path = os.environ["OPENCEPH_SOCKET_PATH"]
    ipc = IpcClient(socket_path, tentacle_id)
    ipc.connect()
    ipc.register("{purpose}", "python")

    def on_directive(payload: dict):
        if payload.get("action") in {{"run_now", "set_self_schedule"}}:
            RUN_NOW.set()

    ipc.on_directive(on_directive)
    if os.environ.get("OPENCEPH_TRIGGER_MODE", "external") == "self":
        RUN_NOW.set()

    interval = int(os.environ.get("GENERATED_INTERVAL_SECONDS", "21600"))
    while True:
        RUN_NOW.wait(timeout=interval)
        RUN_NOW.clear()
        findings = collect_findings()
        if findings:
            ipc.consultation_request("batch", findings, "{purpose}", tentacle_id)


if __name__ == "__main__":
    main()
"""
