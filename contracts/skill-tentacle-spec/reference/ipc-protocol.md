# IPC 通信协议完整参考

**文件位置：** `contracts/skill-tentacle-spec/reference/ipc-protocol.md`  
**用途：** 触手与 Brain 之间的全部 IPC 消息格式定义

---

## 1. 传输层

- **传输方式：** stdin/stdout pipe（子进程 stdio）
- **消息格式：** JSON Lines — 每条消息是一行合法 JSON，以 `\n` 结尾
- **stderr：** 用于日志输出，不参与 IPC，Brain 将 stderr 内容写入触手的 `logs/daemon.log`
- **编码：** UTF-8
- **方向：** 双工。触手写 stdout = 发消息给 Brain；触手读 stdin = 接收 Brain 消息

**重要：** 不使用 Unix Domain Socket、TCP、HTTP。Brain 通过 `child_process.spawn()` 启动触手，stdio 配置为 pipe 模式。

---

## 2. 消息信封格式

所有消息共享统一信封：

```json
{
  "type": "string",
  "tentacle_id": "string",
  "message_id": "string (UUID v4)",
  "timestamp": "string (ISO 8601)",
  "payload": {}
}
```

| 字段 | 必须 | 说明 |
|------|------|------|
| `type` | ✅ | 消息类型标识 |
| `tentacle_id` | ✅ | 触手 ID |
| `message_id` | ✅ | 唯一消息 ID（UUID v4） |
| `timestamp` | ✅ | ISO 8601 格式的 UTC 时间 |
| `payload` | ✅ | 消息体，结构因 type 而异 |

---

## 3. 触手 → Brain 消息

### 3.1 tentacle_register

**触发时机：** 触手进程启动后立即发送（必须在 30 秒内）

```json
{
  "type": "tentacle_register",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-001",
  "timestamp": "2026-03-26T10:00:00Z",
  "payload": {
    "purpose": "监控 arXiv 最新论文",
    "runtime": "python",
    "pid": 12346,
    "capabilities": {
      "daemon": ["rss_fetch", "api_integration", "database"],
      "agent": ["content_analysis", "quality_judgment"],
      "consultation": {
        "mode": "batch",
        "batchThreshold": 5
      }
    },
    "tools": ["search_arxiv", "fetch_paper_details"],
    "version": "1.0.0"
  }
}
```

| payload 字段 | 必须 | 类型 | 说明 |
|-------------|------|------|------|
| `purpose` | ✅ | string | 触手目的（一句话） |
| `runtime` | ✅ | string | `python` / `typescript` / `go` / `shell` |
| `pid` | ✅ | number | 进程 PID |
| `capabilities` | ✅ | object | 三层能力声明 |
| `capabilities.daemon` | ✅ | string[] | 第一层能力列表 |
| `capabilities.agent` | ✅ | string[] | 第二层能力列表 |
| `capabilities.consultation` | ✅ | object | 第三层策略 |
| `capabilities.consultation.mode` | ✅ | string | `batch` / `realtime` / `periodic` |
| `capabilities.consultation.batchThreshold` | batch 模式必须 | number | 积攒阈值 |
| `tools` | ❌ | string[] | 自建工具名称列表 |
| `version` | ❌ | string | 触手版本号 |

**Brain 响应：** 无显式响应。Brain 收到后标记触手为 `running`。如果 30 秒内未收到此消息，Brain 会 kill 进程。

---

### 3.2 consultation_request

**触发时机：** 触手 Agent 层筛选出值得汇报的内容后

```json
{
  "type": "consultation_request",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-010",
  "timestamp": "2026-03-26T14:30:00Z",
  "payload": {
    "mode": "batch",
    "summary": "发现 5 篇值得关注的 AI Agent 论文",
    "item_count": 5,
    "urgency": "normal",
    "initial_message": "我刚完成了一轮 arXiv 扫描...\n\n### 概览\n1. [重要] Multi-Agent Planning with LLM...\n2. ...",
    "context": {
      "total_scanned": 87,
      "rule_filtered": 23,
      "agent_filtered": 5,
      "time_range": "最近 12 小时"
    }
  }
}
```

| payload 字段 | 必须 | 类型 | 说明 |
|-------------|------|------|------|
| `mode` | ✅ | string | `batch` / `realtime` / `periodic` |
| `summary` | ✅ | string | 一句话摘要 |
| `item_count` | ✅ | number | 汇报项目数 |
| `urgency` | ❌ | string | `urgent` / `normal` / `low`（默认 `normal`） |
| `initial_message` | ✅ | string | 完整的汇报内容（自然语言，作为 consultation session 的第一条 user 消息） |
| `context` | ❌ | object | 额外上下文（统计信息等） |

**Brain 响应：** Brain 创建 consultation session 后通过 `consultation_reply` 回复。

---

### 3.3 consultation_message

**触发时机：** consultation 进行中，触手需要发送后续消息（回答 Brain 追问等）

```json
{
  "type": "consultation_message",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-012",
  "timestamp": "2026-03-26T14:31:00Z",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "message": "好的，第一篇论文的具体方法是...\n\n他们提出了一个叫 MAPLE 的框架..."
  }
}
```

| payload 字段 | 必须 | 类型 | 说明 |
|-------------|------|------|------|
| `consultation_id` | ✅ | string | 由 Brain 在首次 reply 中返回 |
| `message` | ✅ | string | 消息内容（自然语言） |

---

### 3.4 consultation_end

**触发时机：** 触手主动认为汇报完毕（通常不需要，Brain 会发 consultation_close）

```json
{
  "type": "consultation_end",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-015",
  "timestamp": "2026-03-26T14:35:00Z",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "reason": "所有追问已回答完毕"
  }
}
```

---

### 3.5 status_update

**触发时机：** 每次 daemon 循环结束后 / 状态变化时

```json
{
  "type": "status_update",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-030",
  "timestamp": "2026-03-26T16:00:00Z",
  "payload": {
    "status": "idle",
    "last_daemon_run": "2026-03-26T16:00:00Z",
    "pending_items": 2,
    "next_scheduled_run": "2026-03-27T04:00:00Z",
    "health": "ok",
    "stats": {
      "total_scanned_today": 142,
      "total_filtered_today": 23,
      "llm_calls_today": 8,
      "tokens_used_today": 12400
    }
  }
}
```

| payload 字段 | 必须 | 类型 | 说明 |
|-------------|------|------|------|
| `status` | ✅ | string | `idle` / `running` / `paused` / `error` |
| `last_daemon_run` | ✅ | string | 上次 daemon 执行时间 |
| `pending_items` | ✅ | number | 待汇报队列长度 |
| `next_scheduled_run` | ❌ | string | 下次计划执行时间 |
| `health` | ✅ | string | `ok` / `degraded` / `error` |
| `stats` | ❌ | object | 运行统计 |

---

### 3.6 heartbeat_ack

**触发时机：** 收到 Brain 的 `heartbeat_ping` 后，必须在 10 秒内响应

```json
{
  "type": "heartbeat_ack",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-050",
  "timestamp": "2026-03-26T16:05:00Z",
  "payload": {}
}
```

---

### 3.7 tool_request

**触发时机：** 触手的 Agent Loop 需要调用共享工具（`openceph_` 前缀）时

```json
{
  "type": "tool_request",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-040",
  "timestamp": "2026-03-26T14:31:00Z",
  "payload": {
    "tool_name": "openceph_web_search",
    "tool_call_id": "call_abc123",
    "arguments": {
      "query": "MAPLE multi-agent planning framework"
    }
  }
}
```

| payload 字段 | 必须 | 类型 | 说明 |
|-------------|------|------|------|
| `tool_name` | ✅ | string | 共享工具名（`openceph_` 前缀） |
| `tool_call_id` | ✅ | string | LLM 返回的 tool_call ID |
| `arguments` | ✅ | object | 工具参数 |

---

## 4. Brain → 触手 消息

### 4.1 consultation_reply

**触发时机：** Brain 在 consultation session 中回复

```json
{
  "type": "consultation_reply",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-011",
  "timestamp": "2026-03-26T14:30:30Z",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "message": "第一篇论文看起来不错。这个 MAPLE 框架的具体方法论是什么？和 ReAct 有什么区别？",
    "actions_taken": [],
    "continue": true
  }
}
```

**Brain 推送给用户后的回复示例：**

```json
{
  "type": "consultation_reply",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-013",
  "timestamp": "2026-03-26T14:32:00Z",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "message": "第一篇论文我已经推送给用户了。第二篇 benchmark 提升太小，不推。第三篇帮我看看实验设置？",
    "actions_taken": [
      {
        "action": "pushed_to_user",
        "item_ref": "论文 1: Multi-Agent Planning with LLM",
        "push_id": "p-uuid-001"
      }
    ],
    "continue": true
  }
}
```

| payload 字段 | 必须 | 类型 | 说明 |
|-------------|------|------|------|
| `consultation_id` | ✅ | string | Consultation session ID |
| `message` | ✅ | string | Brain 的回复内容 |
| `actions_taken` | ✅ | array | Brain 已执行的动作列表 |
| `actions_taken[].action` | ✅ | string | 动作类型：`pushed_to_user` / `queued_for_digest` |
| `actions_taken[].item_ref` | ✅ | string | 对应的项目描述 |
| `actions_taken[].push_id` | ❌ | string | 推送 ID |
| `continue` | ✅ | boolean | `true` = 继续对话；`false` = 结束 |

---

### 4.2 consultation_close

**触发时机：** Brain 决定结束 consultation session

```json
{
  "type": "consultation_close",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-020",
  "timestamp": "2026-03-26T14:35:00Z",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "summary": "本次汇报处理完毕。推送了 2 篇论文给用户，3 篇归档。",
    "pushed_count": 2,
    "discarded_count": 3,
    "feedback": "下次论文筛选可以更关注方法论创新，纯 benchmark 提升的参考价值有限。"
  }
}
```

| payload 字段 | 必须 | 类型 | 说明 |
|-------------|------|------|------|
| `consultation_id` | ✅ | string | Consultation session ID |
| `summary` | ✅ | string | 处理结果摘要 |
| `pushed_count` | ✅ | number | 推送给用户的数量 |
| `discarded_count` | ✅ | number | 丢弃的数量 |
| `feedback` | ❌ | string | Brain 对触手后续工作的建议 |

**触手收到后应该：**
1. 清空 pending 队列中已提交的内容
2. 将 consultation 记录写入 `reports/submitted/`
3. 更新 `workspace/STATUS.md` 和 `workspace/REPORTS.md`
4. 如果有 `feedback`，写入日志供后续 Agent 激活时参考

---

### 4.3 directive

**触发时机：** Brain 需要控制触手行为时（任何时候）

```json
{
  "type": "directive",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-100",
  "timestamp": "2026-03-26T22:00:00Z",
  "payload": {
    "action": "pause",
    "reason": "用户请求暂停",
    "params": {}
  }
}
```

| action | 必须处理 | 说明 | params |
|--------|---------|------|--------|
| `pause` | ✅ | 暂停 daemon 循环和 Agent 激活 | 无 |
| `resume` | ✅ | 恢复运行 | 无 |
| `kill` | ✅ | 优雅退出（清理资源后 exit 0） | 无 |
| `run_now` | ❌ | 立即触发一次 daemon 执行 | 无 |
| `config_update` | ❌ | 更新配置 | `{ "key": "value" }` |
| `flush_pending` | ❌ | 强制把 pending 内容提交 consultation | 无 |

---

### 4.4 heartbeat_ping

**触发时机：** Brain 定期检测触手存活状态

```json
{
  "type": "heartbeat_ping",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-200",
  "timestamp": "2026-03-26T16:05:00Z",
  "payload": {}
}
```

触手必须在 10 秒内回复 `heartbeat_ack`，否则 Brain 会标记触手为不健康。

---

### 4.5 tool_result

**触发时机：** Brain 执行完触手请求的共享工具后

```json
{
  "type": "tool_result",
  "tentacle_id": "t_arxiv_scout",
  "message_id": "msg-uuid-041",
  "timestamp": "2026-03-26T14:31:05Z",
  "payload": {
    "tool_call_id": "call_abc123",
    "result": {
      "content": "搜索结果：MAPLE (Multi-Agent Planning via Language-based Exploration) 是..."
    },
    "success": true,
    "error": null
  }
}
```

| payload 字段 | 必须 | 类型 | 说明 |
|-------------|------|------|------|
| `tool_call_id` | ✅ | string | 对应 tool_request 中的 ID |
| `result` | ✅ | object | 工具执行结果 |
| `success` | ✅ | boolean | 是否成功 |
| `error` | ❌ | string | 失败原因（success=false 时） |

---

## 5. 消息时序图

### 5.1 正常 consultation 流程

```
触手                                Brain                            用户
 │                                    │                                │
 │ tentacle_register ───────────────→ │                                │
 │                                    │ (标记 running)                 │
 │                                    │                                │
 │ ... daemon 运行中，积攒数据 ...      │                                │
 │                                    │                                │
 │ consultation_request ────────────→ │                                │
 │   (initial_message: 汇报内容)       │                                │
 │                                    │ (创建 consultation session)     │
 │                                    │ (加载 CONSULTATION.md prompt)   │
 │                                    │                                │
 │ ←──────────── consultation_reply   │                                │
 │   (message: "第一篇详细说说？")      │                                │
 │   (continue: true)                 │                                │
 │                                    │                                │
 │ consultation_message ────────────→ │                                │
 │   (回答 Brain 追问)                │                                │
 │                                    │ (判断：这条值得推送)             │
 │                                    │ send_to_user() ──────────────→ │
 │                                    │                                │ 用户收到推送
 │ ←──────────── consultation_reply   │                                │
 │   (actions_taken: pushed_to_user)  │                                │
 │   (message: "已推送。第二篇不推。")  │                                │
 │   (continue: true)                 │                                │
 │                                    │                                │
 │ ←──────────── consultation_close   │                                │
 │   (pushed: 1, discarded: 1)        │                                │
 │                                    │                                │
 │ status_update ──────────────────→  │                                │
 │   (status: idle, pending: 0)       │                                │
```

### 5.2 共享工具调用流程

```
触手 Agent Loop                        Brain
 │                                      │
 │ (LLM 返回 tool_calls:               │
 │  openceph_web_search)                │
 │                                      │
 │ tool_request ──────────────────────→ │
 │   (tool_name: openceph_web_search)   │
 │                                      │ (执行 web search)
 │                                      │
 │ ←────────────────────── tool_result  │
 │   (result: 搜索结果)                  │
 │                                      │
 │ (把 result 放入 messages,            │
 │  继续 Agent Loop)                    │
```
