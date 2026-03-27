#!/usr/bin/env python3
"""
Template Monitor — OpenCeph skill_tentacle 完整模板

这是一个可直接运行的 Python 触手模板。
替换 fetch_new_data()、rule_filter()、execute_my_tool() 的实现即可。

三层架构：
  第一层 — 工程 Daemon（while 循环，纯代码，不消耗 token）
  第二层 — Agent 能力（按策略激活 LLM 做分析判断）
  第三层 — Consultation（与 Brain 多轮对话汇报发现）
"""

import os
import sys
import json
import signal
import threading
from pathlib import Path
from datetime import datetime, timezone

from dotenv import load_dotenv
load_dotenv()

from openceph_runtime import (
    IpcClient,
    LlmClient,
    AgentLoop,
    TentacleLogger,
    TentacleConfig,
    StateDB,
    load_tools,
)

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 配置
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

config = TentacleConfig()
log = TentacleLogger()

# 从 .env 读取自定义配置
TOPICS = [t.strip() for t in config.get("MONITOR_TOPICS", "AI,LLM").split(",") if t.strip()]
BATCH_THRESHOLD = config.batch_threshold  # 从 SKILL.md consultation.batchThreshold 读取
POLL_INTERVAL = int(config.get("POLL_INTERVAL_SECONDS", "21600"))  # 默认 6h

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 全局状态
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_shutdown = threading.Event()
_paused = threading.Event()
_run_now = threading.Event()

signal.signal(signal.SIGTERM, lambda *_: _shutdown.set())
signal.signal(signal.SIGINT, lambda *_: _shutdown.set())

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# IPC 初始化
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ipc = IpcClient()


@ipc.on_directive
def handle_directive(action: str, params: dict):
    """处理 Brain 下达的指令"""
    log.daemon("directive_received", action=action)
    if action == "pause":
        _paused.set()
    elif action == "resume":
        _paused.clear()
    elif action == "kill":
        _shutdown.set()
    elif action == "run_now":
        _run_now.set()
    elif action == "flush_pending":
        _run_now.set()  # 触发一次执行，Agent 会把 pending 全部提交


@ipc.on_consultation_reply
def handle_consultation_reply(
    consultation_id: str,
    message: str,
    actions_taken: list,
    should_continue: bool,
):
    """处理 Brain 在 consultation 中的回复"""
    # 记录 Brain 执行的动作
    for action in actions_taken:
        if action.get("action") == "pushed_to_user":
            log.consultation("item_pushed",
                id=consultation_id,
                item_ref=action.get("item_ref", ""),
                push_id=action.get("push_id", ""),
            )

    if not should_continue:
        log.consultation("brain_done", id=consultation_id)
        return

    # Brain 追问了，用 Agent 能力回答
    log.consultation("brain_question", id=consultation_id, question=message[:100])
    answer = answer_brain_question(message)
    ipc.consultation_message(consultation_id, answer)


@ipc.on_consultation_close
def handle_consultation_close(
    consultation_id: str,
    summary: str,
    pushed_count: int,
    discarded_count: int,
    feedback: str | None,
):
    """Consultation 结束，清理和归档"""
    log.consultation("ended",
        id=consultation_id,
        pushed=pushed_count,
        discarded=discarded_count,
    )

    # 归档
    submitted_dir = Path(config.tentacle_dir) / "reports" / "submitted"
    submitted_dir.mkdir(parents=True, exist_ok=True)
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    archive_path = submitted_dir / f"{date_str}-{consultation_id[:8]}.json"
    archive_path.write_text(json.dumps({
        "consultation_id": consultation_id,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "pushed_count": pushed_count,
        "discarded_count": discarded_count,
        "brain_feedback": feedback,
    }, ensure_ascii=False, indent=2))

    # 保存 feedback 供后续 Agent 参考
    if feedback:
        db.set_state("last_brain_feedback", feedback)

    # 更新 workspace 文件
    update_status_md()
    update_reports_md(consultation_id, pushed_count, discarded_count, feedback)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 第一层：工程 Daemon 逻辑（替换这些函数）
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def fetch_new_data() -> list[dict]:
    """
    从数据源抓取新数据。
    纯工程代码，不消耗 LLM token。
    返回原始数据列表。

    【替换此函数为你的数据源抓取逻辑】
    """
    # 示例：返回空列表
    log.daemon("fetch_start", source="template", topics=TOPICS)
    items = []
    # TODO: 实现你的数据抓取逻辑
    # items = your_api.fetch(topics=TOPICS, since=last_fetch_time)
    log.daemon("fetch_end", items=len(items))
    return items


def rule_filter(items: list[dict]) -> list[dict]:
    """
    规则预过滤。
    纯代码逻辑，不消耗 LLM token。
    返回通过过滤的项目。

    【替换此函数为你的过滤规则】
    """
    filtered = []
    for item in items:
        if db.is_processed(item.get("id", "")):
            continue
        # TODO: 实现你的过滤规则
        # if item["score"] >= MIN_SCORE and keyword_match(item, TOPICS):
        #     filtered.append(item)
        filtered.append(item)
        db.mark_processed(item.get("id", ""))
    log.daemon("rule_filter", input=len(items), output=len(filtered))
    return filtered


def execute_my_tool(tool_name: str, arguments: dict) -> str:
    """
    执行自建工具。
    Agent Loop 中 LLM 返回 tool_calls 时，非 openceph_ 前缀的工具在此执行。

    【替换此函数为你的工具实现】
    """
    if tool_name == "fetch_items":
        # TODO: 实现
        return json.dumps({"results": [], "count": 0})
    elif tool_name == "get_item_details":
        # TODO: 实现
        return json.dumps({"error": "not implemented"})
    else:
        return json.dumps({"error": f"Unknown tool: {tool_name}"})


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 第二层：Agent 逻辑
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def activate_agent(pending_items: list[dict]) -> list[dict]:
    """激活 Agent 分析积攒的数据，返回值得汇报的项目"""
    log.agent("activated", pending_count=len(pending_items))

    tools = load_tools("tools/tools.json")
    system_prompt = (Path(config.workspace) / "SYSTEM.md").read_text()

    agent = AgentLoop(
        system_prompt=system_prompt,
        tools=tools,
        max_turns=20,
        ipc=ipc,
    )

    user_message = format_items_for_agent(pending_items)
    result = agent.run(
        user_message=user_message,
        tool_executor=execute_my_tool,
    )

    consultation_items = parse_agent_result(result)
    log.agent("result", items_kept=len(consultation_items), items_discarded=len(pending_items) - len(consultation_items))
    return consultation_items


def answer_brain_question(question: str) -> str:
    """Brain 在 consultation 中追问时，用 Agent 能力回答"""
    llm = LlmClient()
    system_prompt = (Path(config.workspace) / "SYSTEM.md").read_text()

    # 简单情况：直接调 LLM 回答
    response = llm.chat([
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"Brain 追问了以下问题，请回答：\n\n{question}"},
    ])
    return response.content


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 辅助函数
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def format_items_for_agent(items: list[dict]) -> str:
    """将积攒的项目格式化为 Agent 的输入"""
    lines = [f"以下是 {len(items)} 条待分析的内容：\n"]
    for i, item in enumerate(items, 1):
        lines.append(f"{i}. {item.get('title', '未知标题')}")
        if item.get("summary"):
            lines.append(f"   {item['summary']}")
        if item.get("url"):
            lines.append(f"   链接：{item['url']}")
        lines.append("")
    lines.append("请分析每条内容，判断哪些值得向 Brain 汇报，哪些可以丢弃。")
    return "\n".join(lines)


def parse_agent_result(result: str) -> list[dict]:
    """解析 Agent 的分析结果，提取值得汇报的项目"""
    # 简单实现：返回 Agent 原始结果作为一个整体
    # 实际实现中应解析 Agent 的结构化输出
    return [{"content": result, "judgment": "reference"}]


def format_consultation_report(items: list[dict]) -> str:
    """格式化 consultation 汇报内容"""
    lines = [f"我刚完成了一轮扫描，筛选出 {len(items)} 条值得关注的内容。\n"]
    for i, item in enumerate(items, 1):
        judgment = item.get("judgment", "reference")
        label = "重要" if judgment == "important" else "参考"
        lines.append(f"{i}. **[{label}]** {item.get('title', '')}")
        lines.append(f"   {item.get('content', '')[:200]}")
        if item.get("url"):
            lines.append(f"   链接：{item['url']}")
        lines.append("")
    return "\n".join(lines)


def update_status_md():
    """更新 workspace/STATUS.md"""
    status_path = Path(config.workspace) / "STATUS.md"
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    content = f"""# {config.get("TENTACLE_DISPLAY_NAME", config.tentacle_id)} — 运行状态

## 当前状态
- **运行状态：** 正常运行中
- **上次工程层执行：** {now}
- **当前待汇报队列：** 0 条

## 统计
- 扫描总数：{db.get_stat("total_scanned")}
- 汇报总数：{db.get_stat("total_reported")}
"""
    status_path.write_text(content)


def update_reports_md(consultation_id, pushed_count, discarded_count, feedback):
    """追加 consultation 记录到 workspace/REPORTS.md"""
    reports_path = Path(config.workspace) / "REPORTS.md"
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")

    entry = f"\n## {now} — Consultation #{consultation_id[:8]}\n"
    entry += f"- 推送 {pushed_count} 条，丢弃 {discarded_count} 条\n"
    if feedback:
        entry += f"- Brain 反馈：{feedback}\n"

    if reports_path.exists():
        content = reports_path.read_text()
    else:
        content = "# 历史汇报记录\n"
    content += entry
    reports_path.write_text(content)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 主循环
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

db = StateDB()


def main():
    pending = []

    # IPC 连接和注册
    ipc.connect()
    ipc.register(purpose=config.purpose, runtime="python")
    log.daemon("started", trigger_mode=config.trigger_mode, poll_interval=POLL_INTERVAL)

    while not _shutdown.is_set():
        # 暂停检查
        if _paused.is_set():
            _paused.wait(timeout=60)
            continue

        try:
            # ─── 第一层：工程 Daemon ───
            raw = fetch_new_data()
            filtered = rule_filter(raw)
            pending.extend(filtered)
            db.increment_stat("total_scanned", len(raw))

            log.daemon("cycle_complete",
                scanned=len(raw),
                filtered=len(filtered),
                pending=len(pending),
            )

            # ─── 判断是否激活第二层 ───
            if len(pending) >= BATCH_THRESHOLD:
                log.agent("activating", pending_count=len(pending))

                # ─── 第二层：Agent 分析 ───
                consultation_items = activate_agent(pending)

                if consultation_items:
                    # ─── 第三层：发起 Consultation ───
                    report = format_consultation_report(consultation_items)
                    ipc.consultation_request(
                        mode="batch",
                        summary=f"发现 {len(consultation_items)} 条值得关注的内容",
                        initial_message=report,
                        context={
                            "total_scanned": db.get_stat("total_scanned"),
                            "time_range": "最近一轮",
                        },
                    )
                    db.increment_stat("total_reported", len(consultation_items))
                    pending = []

            # ─── 状态更新 ───
            ipc.status_update(
                status="idle",
                pending_items=len(pending),
                health="ok",
            )
            update_status_md()

        except Exception as e:
            log.daemon("error", error=str(e), exc_info=True)

        # 等待下一次触发
        _run_now.wait(timeout=POLL_INTERVAL)
        _run_now.clear()

    # ─── 优雅退出 ───
    if pending:
        log.daemon("flushing_pending", count=len(pending))
    ipc.close()
    log.daemon("stopped")


if __name__ == "__main__":
    if "--dry-run" in sys.argv:
        print(f"✓ Tentacle ID: {os.environ.get('OPENCEPH_TENTACLE_ID', 'NOT SET')}")
        print(f"✓ LLM Gateway: {os.environ.get('OPENCEPH_LLM_GATEWAY_URL', 'NOT SET')}")
        print(f"✓ Workspace: {os.environ.get('OPENCEPH_TENTACLE_WORKSPACE', 'NOT SET')}")
        print(f"✓ Topics: {TOPICS}")
        print(f"✓ Batch threshold: {BATCH_THRESHOLD}")
        print(f"✓ Poll interval: {POLL_INTERVAL}s")
        sys.exit(0)
    main()
