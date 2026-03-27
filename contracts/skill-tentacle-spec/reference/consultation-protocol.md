# Consultation Session 协议完整参考

**文件位置：** `contracts/skill-tentacle-spec/reference/consultation-protocol.md`  
**用途：** 触手与 Brain 之间 Consultation Session 的完整交互流程

---

## 1. 概述

Consultation Session 是触手 Agent 与 Brain Agent 之间的多轮对话。触手作为 "user" 汇报发现，Brain 作为 "assistant" 阅读、追问、做推送决策。

**关键特性：**
- Brain 在对话过程中可以**随时**调用 `send_to_user` 推送给用户，不需等到对话结束
- Brain 可以追问触手细节，触手用自己的 Agent 能力（调 LLM、调工具）回答
- 一次 consultation 可以处理多条汇报项目

---

## 2. 完整流程

```
触手（积攒够了 / 有紧急项）
  │
  │ 第二层 Agent 激活，分析积攒内容
  │ 整理成结构化的汇报报告
  │
  ▼
步骤 1：触手发送 consultation_request
  │     payload.initial_message = 完整汇报内容
  │
  ▼
步骤 2：Brain 创建 Consultation Session
  │     · 生成 consultation_id
  │     · 加载 ~/.openceph/workspace/CONSULTATION.md 模板
  │     · 填充占位符（触手信息、用户记忆、偏好）
  │     · 将 initial_message 作为第一条 "user" 消息
  │
  ▼
步骤 3：Brain 处理汇报
  │     Brain 阅读内容，可能执行以下动作：
  │     (a) 调用 send_to_user → 推送重要信息给用户
  │     (b) 回复触手追问细节
  │     (c) 告知触手某些内容不推送
  │     → 发送 consultation_reply
  │
  ▼
步骤 4：触手收到 reply
  │     检查 payload.continue：
  │     · true → Brain 还有追问，处理后发 consultation_message
  │     · false → 跳到步骤 6
  │     检查 payload.actions_taken：
  │     · 记录哪些已推送、哪些已丢弃
  │
  ▼
步骤 5：多轮对话（重复步骤 3-4）
  │     · Brain 追问 → 触手回答 → Brain 再判断
  │     · Brain 随时可能推送给用户（actions_taken 中体现）
  │     · 直到 Brain 发送 continue=false 或 consultation_close
  │
  ▼
步骤 6：Consultation 结束
  │     Brain 发送 consultation_close
  │     触手收到后：
  │     · 清空 pending 队列中已提交的内容
  │     · 写入 reports/submitted/ 归档
  │     · 更新 workspace/STATUS.md
  │     · 更新 workspace/REPORTS.md
  │     · 如果有 feedback，记录供后续 Agent 参考
  │
  ▼
触手回到第一层 daemon 循环
```

---

## 3. 触手侧实现要点

### 3.1 发起 consultation

```python
# 当积攒内容达到阈值时
if len(pending) >= config.batch_threshold:
    # 先用 Agent 分析、筛选
    consultation_items = activate_agent(pending)

    if consultation_items:
        # 整理汇报内容
        report = format_consultation_report(consultation_items)

        # 发起 consultation
        ipc.consultation_request(
            mode="batch",
            summary=f"发现 {len(consultation_items)} 条值得关注的内容",
            initial_message=report,
            context={"total_scanned": db.get_stat("total_scanned")},
        )
        pending = []  # 清空已提交的 pending
```

### 3.2 处理 Brain 追问

```python
@ipc.on_consultation_reply
def handle_reply(consultation_id, message, actions_taken, should_continue):
    # 记录 Brain 的动作
    for action in actions_taken:
        if action["action"] == "pushed_to_user":
            log.consultation("item_pushed", item_ref=action["item_ref"])

    if not should_continue:
        return  # Brain 不再追问

    # Brain 追问了，需要回答
    # 使用 Agent 能力获取详情
    answer = answer_brain_question(message, consultation_id)
    ipc.consultation_message(consultation_id, answer)


def answer_brain_question(question, consultation_id):
    """用 Agent 能力回答 Brain 的追问"""
    llm = LlmClient()
    tools = load_tools("tools/tools.json")

    # 可以启动一个小的 Agent Loop 来回答
    agent = AgentLoop(
        system_prompt=f"你正在回答 Brain 的追问。问题：{question}",
        tools=tools,
        max_turns=5,
        ipc=ipc,
    )
    return agent.run(
        user_message=question,
        tool_executor=my_tool_executor,
    )
```

### 3.3 处理 consultation 结束

```python
@ipc.on_consultation_close
def handle_close(consultation_id, summary, pushed_count, discarded_count, feedback):
    log.consultation("ended",
        id=consultation_id,
        pushed=pushed_count,
        discarded=discarded_count,
    )

    # 归档
    archive_data = {
        "consultation_id": consultation_id,
        "submitted_at": datetime.now(timezone.utc).isoformat(),
        "items_count": pushed_count + discarded_count,
        "pushed_count": pushed_count,
        "discarded_count": discarded_count,
        "brain_feedback": feedback,
    }
    archive_path = Path(config.tentacle_dir) / "reports" / "submitted" / f"{date_str}-{consultation_id}.json"
    archive_path.write_text(json.dumps(archive_data, ensure_ascii=False, indent=2))

    # 更新 workspace 文件
    update_status_md()
    append_to_reports_md(consultation_id, pushed_count, discarded_count, feedback)

    # 如果有 feedback，保存供后续 Agent 参考
    if feedback:
        db.set_state("last_brain_feedback", feedback)
```

---

## 4. 汇报内容格式建议

initial_message 是自然语言，但建议使用以下结构化格式便于 Brain 阅读：

```
我刚完成了一轮 {数据源} 扫描，从 {总数} 条数据中筛选出 {N} 条值得关注的。

### 概览
- 扫描范围：{时间范围}
- 总计扫描：{总数}
- 规则筛选：{规则筛选数}
- Agent 精读保留：{N}

### 详细发现

1. **[重要] {标题}**
   {2-3 句话摘要}
   重要程度：important
   理由：{为什么值得推送给用户}
   链接：{URL}

2. **[参考] {标题}**
   {摘要}
   重要程度：reference
   理由：{为什么保留但不紧急}
   链接：{URL}

3. ...
```

---

## 5. Consultation Session 超时与限制

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxTurns` | 20 | 最大对话轮次（超过后 Brain 强制结束） |
| `maxAgeMinutes` | 30 | 最长持续时间（超过后 Brain 强制结束） |
| `replyTimeout` | 120s | 触手回复超时（超过后 Brain 视为触手无法回答） |

这些参数在 `openceph.json` 的 `tentacle.consultation` 中配置。

---

## 6. 紧急 consultation

当触手发现紧急内容（如 uptime-watchdog 检测到服务宕机）时：

```python
ipc.consultation_request(
    mode="realtime",        # 不是 batch
    summary="紧急：API 端点不可达",
    urgency="urgent",       # 标记为紧急
    initial_message="🚨 检测到 https://api.myapp.com/health 返回 503...",
    context={},
)
```

Brain 收到 `urgency: "urgent"` 的 consultation 会立即处理（跳过排队），通常会直接推送给用户。
