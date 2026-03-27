# OpenCeph skill_tentacle 规范文档

**本文档是 Claude Code 生成或修改 skill_tentacle 时的权威规范。**  
**每次工作前必须完整阅读本文件以及 `reference/` 目录下的所有参考文件。**

---

## 目录

- [1. 概述](#1-概述)
- [2. 目录结构规范](#2-目录结构规范)
- [3. 三层架构规范](#3-三层架构规范)
- [4. SKILL.md 规范](#4-skillmd-规范)
- [5. IPC 通信规范](#5-ipc-通信规范)
- [6. LLM Gateway 调用规范](#6-llm-gateway-调用规范)
- [7. openceph-runtime 库使用规范](#7-openceph-runtime-库使用规范)
- [8. Workspace 文件规范](#8-workspace-文件规范)
- [9. 工具系统规范](#9-工具系统规范)
- [10. 日志规范](#10-日志规范)
- [11. 绝对禁止清单](#11-绝对禁止清单)
- [12. 验证清单](#12-验证清单)

**补充参考文件（按需查阅 `reference/` 目录）：**
- `reference/ipc-protocol.md` — IPC 消息格式完整定义
- `reference/llm-gateway-api.md` — LLM Gateway HTTP API 完整参考
- `reference/workspace-structure.md` — workspace 目录完整规范
- `reference/openceph-runtime-api.md` — openceph-runtime 库 API 完整参考
- `reference/consultation-protocol.md` — consultation session 协议完整参考

**可运行的完整模板（按需参考 `examples/` 目录）：**
- `examples/python-template/` — Python 触手完整可运行模板
- `examples/typescript-template/` — TypeScript 触手完整可运行模板

---

## 1. 概述

skill_tentacle 是 OpenCeph 系统中的长时运行 Agent 程序。每个触手是一个独立子进程，具备三层能力：工程 Daemon（持续运行）、Agent 能力（LLM 推理）、Consultation 能力（与 Brain 对话）。

触手通过 stdin/stdout 与 Brain 通信（IPC），通过 HTTP 调用 LLM Gateway 获取模型能力。触手不可直接联系用户，所有用户触达必须经过 Brain。

---

## 2. 目录结构规范

生成或修改的 skill_tentacle 必须遵循以下目录结构：

```
{tentacle_dir}/
├── SKILL.md                    # [必须] 蓝图元数据
├── README.md                   # [推荐] 开发说明
│
├── prompt/                     # [必须] Agent prompt 文件
│   └── SYSTEM.md               # [必须] 触手 Agent 的 system prompt
│
├── src/                        # [必须] 工程代码
│   ├── main.py                 # [必须] Python 入口（或 index.ts）
│   └── requirements.txt        # [必须] Python 依赖（或 package.json）
│
├── tools/                      # [如有自建工具则必须]
│   └── tools.json              # 工具定义（OpenAI function 格式）
│
├── workspace/                  # [运行时自动创建]
│   ├── SYSTEM.md               # 从 prompt/SYSTEM.md 填充而来
│   ├── STATUS.md               # 触手自维护的运行状态
│   └── REPORTS.md              # 历史汇报摘要
│
├── data/                       # [运行时自动创建]
│   └── state.db                # SQLite 数据库
│
├── reports/                    # [运行时自动创建]
│   ├── pending/                # 待汇报内容
│   └── submitted/              # 已汇报归档
│
├── logs/                       # [运行时自动创建]
│   ├── daemon.log              # 工程层日志
│   ├── agent.log               # Agent 层日志
│   └── consultation.log        # Consultation 日志
│
└── .env                        # [部署时自动生成，不要手动创建]
```

---

## 3. 三层架构规范

每个触手必须实现三层架构。**不可将三层混在一起。**

### 第一层：工程 Daemon

- 持续运行的主循环
- 纯代码逻辑，**不消耗 LLM token**
- 负责：数据抓取、规则过滤、去重、积攒
- 定时触发或事件驱动
- 用 `while not shutdown` 循环实现

### 第二层：Agent 能力

- 按策略激活（积攒达到阈值、有紧急项、太久没激活）
- 调用 LLM Gateway 做分析、判断、生成
- 使用 `workspace/SYSTEM.md` 作为 system prompt
- 支持 tool call（自建工具 + 共享工具）
- 结果用于准备 consultation 内容

### 第三层：Consultation

- 当 Agent 层筛选出值得汇报的内容后发起
- 通过 IPC 发送 `consultation_request`
- 在 consultation session 中作为 "user" 与 Brain 多轮对话
- 处理 Brain 的追问（可能需要再次调用 Agent 能力获取详情）
- 收到 `consultation_close` 后清理 pending 队列

### 主循环伪代码（必须遵循此结构）

```python
from openceph_runtime import IpcClient, LlmClient, AgentLoop, TentacleLogger, StateDB

ipc = IpcClient()
log = TentacleLogger()

def main():
    ipc.connect()
    ipc.register(purpose="...", runtime="python")

    pending = []

    while not shutdown:
        if paused:
            wait(60)
            continue

        # ─── 第一层：工程 Daemon ───
        raw_items = fetch_new_data()          # 纯代码，不调 LLM
        filtered = rule_filter(raw_items)     # 纯代码，不调 LLM
        pending.extend(filtered)

        # ─── 判断是否激活第二层 ───
        if len(pending) >= BATCH_THRESHOLD:

            # ─── 第二层：Agent ───
            agent_result = run_agent_loop(
                system_prompt=read("workspace/SYSTEM.md"),
                user_message=format_items(pending),
                tools=load_tools("tools/tools.json"),
            )
            consultation_items = parse_result(agent_result)

            if consultation_items:
                # ─── 第三层：Consultation ───
                ipc.consultation_request(
                    mode="batch",
                    summary=f"发现 {len(consultation_items)} 条内容",
                    initial_message=format_report(consultation_items),
                )
                pending = []

        ipc.status_update(status="idle", pending_items=len(pending))
        wait(POLL_INTERVAL)
```

---

## 4. SKILL.md 规范

SKILL.md 使用 YAML frontmatter，必须包含以下字段：

```yaml
---
name: tentacle-name              # 必须，小写连字符
description: |                   # 必须，多行描述
  一句话说明这个触手做什么。
version: 1.0.0                   # 必须，语义化版本

metadata:
  openceph:
    emoji: "🎓"                  # 必须，用于显示
    category: "monitoring"       # 必须：monitoring | execution | curation | tool
    trigger_keywords:            # 必须，Brain 匹配用
      - "关键词1"
      - "关键词2"

    tentacle:
      spawnable: true            # 必须
      runtime: python            # 必须：python | typescript | go | shell
      entry: src/main.py         # 必须，入口文件路径
      default_trigger: "every 12 hours"  # 必须

      setup_commands:            # 必须，部署时执行
        - "python3 -m venv venv"
        - "venv/bin/pip install -r src/requirements.txt"

      requires:
        bins: ["python3"]        # 本机必须安装的命令
        llm: true                # 是否需要 LLM Gateway
        env: []                  # 额外必需的环境变量名

      capabilities:
        daemon:                  # 第一层能力列表
          - "api_integration"
        agent:                   # 第二层能力列表
          - "content_analysis"
        consultation:            # 第三层策略
          mode: "batch"          # batch | realtime | periodic
          batch_threshold: 5     # batch 模式阈值

      infrastructure:
        needsDatabase: true
        needsLlm: true
        needsHttpServer: false

      customizable:              # 用户可配置的字段
        - field: "categories"
          description: "分类列表"
          env_var: "MY_CATEGORIES"
          default: "cs.AI,cs.CL"
---
```

---

## 5. IPC 通信规范

### 传输层

- **协议：** stdin/stdout JSON Lines
- 每条消息独占一行，以 `\n` 结尾
- stderr 用于日志，不参与 IPC
- 编码：UTF-8

### 消息信封格式

```json
{
  "type": "<message_type>",
  "tentacle_id": "t_xxx",
  "message_id": "msg-uuid",
  "timestamp": "2026-03-26T16:00:00Z",
  "payload": { }
}
```

### 必须实现的消息类型

#### 启动注册（触手 → Brain，启动后立即发送）

```json
{
  "type": "tentacle_register",
  "tentacle_id": "t_xxx",
  "message_id": "msg-001",
  "timestamp": "...",
  "payload": {
    "purpose": "触手目的描述",
    "runtime": "python",
    "pid": 12346,
    "capabilities": {
      "daemon": ["api_integration"],
      "agent": ["content_analysis"],
      "consultation": { "mode": "batch", "batchThreshold": 5 }
    },
    "tools": ["tool_name_1", "tool_name_2"],
    "version": "1.0.0"
  }
}
```

#### Consultation 请求（触手 → Brain）

```json
{
  "type": "consultation_request",
  "tentacle_id": "t_xxx",
  "message_id": "msg-010",
  "timestamp": "...",
  "payload": {
    "mode": "batch",
    "summary": "发现 5 条值得关注的内容",
    "item_count": 5,
    "urgency": "normal",
    "initial_message": "完整的汇报内容（自然语言）...",
    "context": {
      "total_scanned": 87,
      "time_range": "最近 12 小时"
    }
  }
}
```

#### Consultation 消息（触手 → Brain，后续对话）

```json
{
  "type": "consultation_message",
  "tentacle_id": "t_xxx",
  "message_id": "msg-012",
  "timestamp": "...",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "message": "Brain 追问的回答..."
  }
}
```

#### 状态更新（触手 → Brain）

```json
{
  "type": "status_update",
  "tentacle_id": "t_xxx",
  "message_id": "msg-030",
  "timestamp": "...",
  "payload": {
    "status": "idle",
    "last_daemon_run": "2026-03-26T16:00:00Z",
    "pending_items": 2,
    "next_scheduled_run": "2026-03-27T04:00:00Z",
    "health": "ok"
  }
}
```

#### 心跳响应（触手 → Brain）

```json
{
  "type": "heartbeat_ack",
  "tentacle_id": "t_xxx",
  "message_id": "msg-050",
  "timestamp": "...",
  "payload": {}
}
```

### 必须处理的 Brain → 触手 消息

#### Directive（Brain → 触手）

```json
{
  "type": "directive",
  "tentacle_id": "t_xxx",
  "message_id": "msg-100",
  "timestamp": "...",
  "payload": {
    "action": "pause | resume | kill | run_now | config_update | flush_pending",
    "reason": "原因描述",
    "params": {}
  }
}
```

**必须处理的 action：** `pause`、`resume`、`kill`。其他为可选。

#### Consultation Reply（Brain → 触手）

```json
{
  "type": "consultation_reply",
  "tentacle_id": "t_xxx",
  "message_id": "msg-011",
  "timestamp": "...",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "message": "Brain 的回复内容...",
    "actions_taken": [
      { "action": "pushed_to_user", "item_ref": "项目描述", "push_id": "p-001" }
    ],
    "continue": true
  }
}
```

当 `continue` 为 `false` 时，consultation 结束。

#### Consultation Close（Brain → 触手）

```json
{
  "type": "consultation_close",
  "tentacle_id": "t_xxx",
  "message_id": "msg-020",
  "timestamp": "...",
  "payload": {
    "consultation_id": "cs-uuid-001",
    "summary": "本次汇报处理结果",
    "pushed_count": 2,
    "discarded_count": 3,
    "feedback": "后续筛选建议"
  }
}
```

#### Heartbeat Ping（Brain → 触手）

```json
{
  "type": "heartbeat_ping",
  "tentacle_id": "t_xxx",
  "message_id": "msg-200",
  "timestamp": "...",
  "payload": {}
}
```

收到后必须在 10 秒内发送 `heartbeat_ack`。

---

## 6. LLM Gateway 调用规范

### 端点和认证

```
URL:   环境变量 OPENCEPH_LLM_GATEWAY_URL（如 http://127.0.0.1:18792）
Token: 环境变量 OPENCEPH_LLM_GATEWAY_TOKEN
```

### 请求格式（OpenAI-compatible）

```
POST {OPENCEPH_LLM_GATEWAY_URL}/v1/chat/completions
Headers:
  Content-Type: application/json
  Authorization: Bearer {OPENCEPH_LLM_GATEWAY_TOKEN}
  X-Tentacle-Id: {OPENCEPH_TENTACLE_ID}
```

```json
{
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "..."}
  ],
  "model": "default",
  "temperature": 0.3,
  "max_tokens": 4096,
  "tools": [ ],
  "stream": false
}
```

**`model` 字段：** 传 `"default"` 或省略即可，Gateway 会使用 openceph.json 中配置的触手模型。

### 响应格式（OpenAI-compatible）

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "回复内容",
      "tool_calls": null
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 340,
    "total_tokens": 1540
  }
}
```

### 带 tool_calls 的响应

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "search_arxiv",
          "arguments": "{\"query\": \"multi-agent\"}"
        }
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

---

## 7. openceph-runtime 库使用规范

**Python 触手必须使用 `openceph-runtime` 库。不要自己实现 IPC 或 LLM 调用。**

### 安装

在 `requirements.txt` 中添加：

```
openceph-runtime>=1.0.0
```

### 核心 API

```python
from openceph_runtime import (
    IpcClient,        # IPC 通信
    LlmClient,        # LLM Gateway 调用
    AgentLoop,        # Agent Loop 执行
    TentacleLogger,   # 结构化日志
    TentacleConfig,   # 配置加载
    StateDB,          # SQLite 状态数据库
    load_tools,       # 加载 tools.json
)
```

### IpcClient 用法

```python
ipc = IpcClient()  # 自动从 env vars 读取配置

# 注册（启动后立即调用）
ipc.register(purpose="触手目的", runtime="python")

# 发起 consultation
ipc.consultation_request(
    mode="batch",
    summary="发现 5 条内容",
    initial_message="汇报内容...",
    context={"total_scanned": 87},
)

# consultation 中后续消息
ipc.consultation_message(consultation_id, message="回答追问...")

# 注册 directive handler
@ipc.on_directive
def handle(action, params):
    if action == "pause": ...
    elif action == "kill": ...

# 注册 consultation reply handler
@ipc.on_consultation_reply
def handle(consultation_id, message, actions_taken, should_continue):
    if not should_continue:
        # consultation 结束
        return
    # Brain 追问了，处理追问
    answer = process_question(message)
    ipc.consultation_message(consultation_id, answer)

# 状态更新
ipc.status_update(status="idle", pending_items=2, health="ok")
```

### LlmClient 用法

```python
llm = LlmClient()  # 自动从 env vars 读取 Gateway URL 和 Token

response = llm.chat([
    {"role": "system", "content": "你是论文分析专家"},
    {"role": "user", "content": "分析这篇论文..."},
], temperature=0.3)

print(response.content)       # 文本回复
print(response.tool_calls)    # tool_calls 列表（可能为 None）
```

### AgentLoop 用法

```python
tools = load_tools("tools/tools.json")

agent = AgentLoop(
    system_prompt=open("workspace/SYSTEM.md").read(),
    tools=tools,
    max_turns=20,
    ipc=ipc,  # 用于共享工具调用
)

result = agent.run(
    user_message="分析以下内容...",
    tool_executor=my_local_tool_executor,  # 自建工具执行函数
)
```

### TentacleLogger 用法

```python
log = TentacleLogger()

log.daemon("fetch_start", url="...", items=87)
log.agent("llm_call", model="default", input_tokens=1200)
log.consultation("started", consultation_id="cs-001")
```

### StateDB 用法

```python
db = StateDB()  # 自动在 data/state.db 创建

if not db.is_processed("arxiv:2403.12345"):
    # 处理...
    db.mark_processed("arxiv:2403.12345")

db.increment_stat("total_scanned", 87)
```

---

## 8. Workspace 文件规范

### workspace/STATUS.md

触手每次运行后必须更新此文件。Brain 可以直接读取。

```markdown
# {触手名} — 运行状态

## 当前状态
- **运行状态：** 正常运行中 | 已暂停 | 出错
- **上次工程层执行：** {时间}（成功 | 失败）
- **上次 Agent 激活：** {时间}
- **上次向 Brain 汇报：** {时间}（推送了 N 条）
- **当前待汇报队列：** N 条（阈值 M）

## 统计
- 扫描总数：N
- 规则筛选：N
- Agent 精读后保留：N
- 已汇报给 Brain：N
- Brain 推送给用户：N

## 最近一次执行摘要
{简短描述最近一次执行的结果}
```

### workspace/REPORTS.md

历史汇报记录的简要摘要。

```markdown
# 历史汇报记录

## 2026-03-26 14:30 — Consultation #cs-001
- 汇报 5 条，Brain 推送 2 条，丢弃 3 条
- 推送内容：论文 A（Multi-Agent Planning）、论文 B（Chain-of-Reasoning）
- Brain 反馈：多关注方法论创新

## 2026-03-25 20:00 — Consultation #cs-000
- 汇报 3 条，Brain 推送 1 条，丢弃 2 条
```

### prompt/SYSTEM.md

支持占位符，部署时由 SkillSpawner 填充：

| 占位符 | 来源 |
|--------|------|
| `{TENTACLE_NAME}` | SKILL.md name |
| `{TENTACLE_EMOJI}` | SKILL.md emoji |
| `{USER_NAME}` | USER.md 用户名 |
| `{USER_FOCUS_AREAS}` | USER.md 关注领域 |
| `{QUALITY_CRITERIA}` | customizable 字段值 |
| `{TOOLS_DESCRIPTION}` | 从 tools.json 生成 |

---

## 9. 工具系统规范

### 自建工具

在 `tools/tools.json` 中定义，OpenAI function calling 格式：

```json
[
  {
    "type": "function",
    "function": {
      "name": "search_arxiv",
      "description": "搜索 arXiv 论文",
      "parameters": {
        "type": "object",
        "properties": {
          "query": { "type": "string", "description": "搜索关键词" }
        },
        "required": ["query"]
      }
    }
  }
]
```

自建工具由触手代码内部实现执行。

### 共享工具（openceph 提供）

工具名以 `openceph_` 前缀开头，通过 IPC 请求 Brain 代为执行。

可用的共享工具：

| 工具名 | 说明 |
|--------|------|
| `openceph_web_search` | 网页搜索 |
| `openceph_web_fetch` | 抓取网页内容 |
| `openceph_read_file` | 读取文件（限触手 workspace） |
| `openceph_write_file` | 写入文件（限触手 workspace） |

Agent Loop 收到 LLM 返回的 `tool_calls` 时：
- 工具名以 `openceph_` 开头 → 通过 `ipc.tool_request()` 请求 Brain 执行
- 其他 → 本地执行（自建工具）

---

## 10. 日志规范

使用 `TentacleLogger`，**不要自己写日志到文件**。

日志自动写入：
- 工程层事件 → `logs/daemon.log`
- Agent 层事件 → `logs/agent.log`
- Consultation 事件 → `logs/consultation.log`

格式：JSON Lines，每行一条。

```python
log = TentacleLogger()

# 工程层
log.daemon("fetch_start", source="arxiv", categories=["cs.AI"])
log.daemon("fetch_end", items=87, duration_ms=2340)
log.daemon("error", error="Connection timeout", exc_info=True)

# Agent 层
log.agent("activated", pending_count=23)
log.agent("llm_call", model="default", input_tokens=4200, output_tokens=890)
log.agent("tool_call", tool="search_arxiv", arguments={"query": "..."})
log.agent("result", items_kept=5, items_discarded=18)

# Consultation
log.consultation("started", id="cs-001", item_count=5)
log.consultation("ended", id="cs-001", pushed=2, discarded=3)
```

---

## 11. 绝对禁止清单

以下行为**绝对禁止**，违反将导致验证失败：

| 禁止行为 | 原因 |
|---------|------|
| 硬编码 API key（如 `OPENROUTER_API_KEY="sk-..."`) | 安全风险，必须通过 LLM Gateway |
| 硬编码 provider URL（如 `openrouter.ai/api/v1`） | 必须通过 LLM Gateway |
| 直接调用外部 LLM API（requests.post 到 openrouter 等） | 必须通过 LLM Gateway |
| 自己实现 IPC 通信（socket/stdin 原始读写） | 必须使用 openceph-runtime IpcClient |
| 自己实现 Agent Loop（不用 AgentLoop 类） | 推荐使用 openceph-runtime AgentLoop |
| 使用 `os.system()`、`subprocess.Popen()` | 安全风险 |
| 使用 `exec()`、`eval()`、`__import__()` | 安全风险 |
| 写入触手 workspace 以外的目录 | 权限违规 |
| 读取 `~/.openceph/credentials/` | 权限违规 |
| 读取 `~/.openceph/workspace/`（Brain workspace） | 权限违规 |
| 直接向用户发消息（绕过 Brain） | 架构违规 |
| 在第一层 daemon 中调用 LLM | 架构违规，第一层不消耗 token |

---

## 12. 验证清单

生成或修改代码后，确保以下检查全部通过：

### 结构检查
- [ ] `src/main.py`（或 `index.ts`）存在
- [ ] `SKILL.md` 存在且 frontmatter 格式正确
- [ ] `prompt/SYSTEM.md` 存在
- [ ] `src/requirements.txt`（或 `package.json`）存在
- [ ] 如果有自建工具：`tools/tools.json` 存在且格式正确

### IPC 契约检查
- [ ] 代码中 `from openceph_runtime import IpcClient`
- [ ] 启动后调用 `ipc.register()`
- [ ] 实现了 `consultation_request` 发送逻辑
- [ ] 注册了 `@ipc.on_directive` handler，至少处理 `pause`、`resume`、`kill`
- [ ] 注册了 `@ipc.on_consultation_reply` handler

### LLM Gateway 检查
- [ ] 代码中 `from openceph_runtime import LlmClient`（如果需要 LLM）
- [ ] 没有硬编码任何 API key 或 provider URL
- [ ] 没有直接调用外部 LLM API

### 三层架构检查
- [ ] 第一层 daemon 循环存在（while not shutdown）
- [ ] 第一层中不调用 LLM
- [ ] 第二层 Agent 激活有明确的触发条件
- [ ] 第三层 consultation 在 Agent 筛选后发起

### 安全检查
- [ ] 没有 `os.system()`、`subprocess.Popen()`、`exec()`、`eval()`
- [ ] 文件写入仅限触手自身目录

### Dry-run 测试
- [ ] `python src/main.py --dry-run` 成功退出（检查配置和依赖）

---

*本规范文档是 Claude Code 生成合格 skill_tentacle 的唯一权威来源。*
*如有疑问，优先查阅 `reference/` 目录下的详细参考文件和 `examples/` 目录下的可运行模板。*
