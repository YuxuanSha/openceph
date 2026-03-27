# openceph-runtime Python 库 API 参考

**文件位置：** `contracts/skill-tentacle-spec/reference/openceph-runtime-api.md`  
**用途：** Python 触手使用的 `openceph-runtime` 库完整 API

---

## 安装

```
pip install openceph-runtime
```

或在 `requirements.txt` 中：
```
openceph-runtime>=1.0.0
```

---

## 模块总览

```python
from openceph_runtime import (
    IpcClient,        # IPC 通信客户端
    LlmClient,        # LLM Gateway 调用客户端
    AgentLoop,        # Agent Loop 执行器
    TentacleLogger,   # 结构化日志
    TentacleConfig,   # 配置加载
    StateDB,          # SQLite 状态管理
    load_tools,       # 加载 tools.json
)
```

所有类都从环境变量自动读取配置，无需手动传参。

---

## IpcClient

### 初始化

```python
ipc = IpcClient()
# 自动读取 OPENCEPH_TENTACLE_ID 环境变量
# 自动配置 stdin/stdout JSON Lines 通信
```

### connect()

启动 stdin 监听线程。在 main() 开头调用。

```python
ipc.connect()
```

### register(purpose, runtime)

注册触手。**启动后必须立即调用。**

```python
ipc.register(
    purpose="监控 arXiv 最新论文",
    runtime="python",
)
```

### consultation_request(mode, summary, initial_message, context=None)

发起 consultation session。

```python
ipc.consultation_request(
    mode="batch",                           # "batch" | "realtime" | "periodic"
    summary="发现 5 篇值得关注的论文",
    initial_message="完整汇报内容...",       # 自然语言，作为 consultation 第一条 user 消息
    context={"total_scanned": 87},          # 可选，额外上下文
)
```

### consultation_message(consultation_id, message)

在 consultation 中发送后续消息（回答 Brain 追问等）。

```python
ipc.consultation_message(
    consultation_id="cs-uuid-001",
    message="第一篇论文的具体方法是...",
)
```

### status_update(status, pending_items, health, **kwargs)

发送状态更新。

```python
ipc.status_update(
    status="idle",          # "idle" | "running" | "paused" | "error"
    pending_items=2,
    health="ok",            # "ok" | "degraded" | "error"
    next_scheduled_run="2026-03-27T04:00:00Z",  # 可选
)
```

### @ipc.on_directive

注册 directive handler。**必须至少处理 pause、resume、kill。**

```python
@ipc.on_directive
def handle_directive(action: str, params: dict):
    if action == "pause":
        paused_event.set()
    elif action == "resume":
        paused_event.clear()
    elif action == "kill":
        shutdown_event.set()
    elif action == "run_now":
        run_now_event.set()
    elif action == "config_update":
        update_config(params)
    elif action == "flush_pending":
        flush_pending()
```

### @ipc.on_consultation_reply

注册 consultation 回复 handler。

```python
@ipc.on_consultation_reply
def handle_reply(
    consultation_id: str,
    message: str,
    actions_taken: list,
    should_continue: bool,
):
    if not should_continue:
        # consultation 结束
        finalize_consultation(consultation_id)
        return

    # Brain 追问了，用 Agent 能力回答
    answer = process_brain_question(message)
    ipc.consultation_message(consultation_id, answer)
```

### @ipc.on_consultation_close

注册 consultation 关闭 handler。

```python
@ipc.on_consultation_close
def handle_close(
    consultation_id: str,
    summary: str,
    pushed_count: int,
    discarded_count: int,
    feedback: str | None,
):
    # 清理 pending 队列
    clear_submitted_items(consultation_id)
    # 更新 workspace 文件
    update_status_md()
    update_reports_md(consultation_id, pushed_count, discarded_count, feedback)
    # 归档
    archive_consultation(consultation_id)
```

### tool_request(tool_name, tool_call_id, arguments) → dict

请求 Brain 执行共享工具。**同步阻塞等待结果。**

```python
result = ipc.tool_request(
    tool_name="openceph_web_search",
    tool_call_id="call_abc123",
    arguments={"query": "MAPLE framework"},
)
# result = {"content": "搜索结果..."}
```

### close()

关闭连接。在触手退出前调用。

```python
ipc.close()
```

---

## LlmClient

### 初始化

```python
llm = LlmClient()
# 自动读取 OPENCEPH_LLM_GATEWAY_URL 和 OPENCEPH_LLM_GATEWAY_TOKEN
```

### chat(messages, tools=None, temperature=None, max_tokens=None, model="default") → LlmResponse

调用 LLM。

```python
response = llm.chat(
    messages=[
        {"role": "system", "content": "你是论文分析专家"},
        {"role": "user", "content": "分析这篇论文..."},
    ],
    tools=my_tools,       # 可选，OpenAI function 格式
    temperature=0.3,      # 可选
    max_tokens=4096,      # 可选
    model="default",      # 可选，默认使用配置
)
```

### LlmResponse 对象

```python
response.content        # str | None — 文本回复
response.tool_calls     # list | None — tool_call 列表
response.finish_reason  # str — "stop" | "tool_calls"
response.usage          # dict — {"prompt_tokens": N, "completion_tokens": N}
response.raw            # dict — 原始 API 响应
```

### tool_call 结构

```python
for tc in response.tool_calls:
    tc.id           # str — "call_abc123"
    tc.name         # str — "search_arxiv"
    tc.arguments    # dict — {"query": "multi-agent"}
```

---

## AgentLoop

### 初始化

```python
from openceph_runtime import AgentLoop, load_tools

tools = load_tools("tools/tools.json")

agent = AgentLoop(
    system_prompt="你是论文分析专家...",
    tools=tools,            # 自建工具 + 共享工具合并列表
    max_turns=20,           # 最大轮次
    ipc=ipc,                # IpcClient 实例，用于共享工具调用
)
```

### run(user_message, tool_executor) → str

执行多轮 Agent Loop，返回最终结论文本。

```python
result = agent.run(
    user_message="从以下 23 篇论文摘要中筛选值得推荐的：\n\n...",
    tool_executor=my_tool_executor,
)
```

### tool_executor 函数签名

```python
def my_tool_executor(tool_name: str, arguments: dict) -> str:
    """执行自建工具，返回结果字符串"""
    if tool_name == "search_arxiv":
        results = arxiv_api.search(arguments["query"])
        return json.dumps(results)
    elif tool_name == "fetch_paper_details":
        paper = arxiv_api.get_paper(arguments["arxiv_id"])
        return json.dumps(paper)
    else:
        return json.dumps({"error": f"Unknown tool: {tool_name}"})
```

**AgentLoop 内部逻辑：**
1. 构造 messages = [system, user]
2. 调用 LlmClient.chat(messages, tools)
3. 如果有 tool_calls：
   - `openceph_` 前缀 → ipc.tool_request() 发给 Brain
   - 其他 → tool_executor() 本地执行
   - 将 tool result 追加到 messages，回到步骤 2
4. 如果无 tool_calls（finish_reason=stop）→ 返回 content

---

## TentacleLogger

### 初始化

```python
log = TentacleLogger()
# 自动写入 logs/daemon.log、logs/agent.log、logs/consultation.log
```

### daemon(event, **kwargs)

工程层日志。

```python
log.daemon("fetch_start", source="arxiv", categories=["cs.AI", "cs.CL"])
log.daemon("fetch_end", items=87, duration_ms=2340)
log.daemon("rule_filter", input=87, output=23)
log.daemon("error", error="Connection timeout", exc_info=True)
log.daemon("cycle_complete", scanned=87, filtered=23, pending=23)
```

### agent(event, **kwargs)

Agent 层日志。

```python
log.agent("activated", pending_count=23)
log.agent("llm_call", model="default", input_tokens=4200, output_tokens=890, duration_ms=3200)
log.agent("tool_call", tool="search_arxiv", arguments={"query": "..."}, duration_ms=450)
log.agent("result", items_kept=5, items_discarded=18)
```

### consultation(event, **kwargs)

Consultation 层日志。

```python
log.consultation("started", id="cs-001", item_count=5)
log.consultation("message_sent", id="cs-001", message_length=1200)
log.consultation("reply_received", id="cs-001", actions=["pushed_to_user"], should_continue=True)
log.consultation("ended", id="cs-001", pushed=2, discarded=3, duration_ms=45000)
```

---

## TentacleConfig

### 初始化

```python
config = TentacleConfig()
# 自动从 .env 和环境变量加载
```

### 属性

```python
config.tentacle_id       # str — OPENCEPH_TENTACLE_ID
config.tentacle_dir      # Path — OPENCEPH_TENTACLE_DIR
config.workspace         # Path — OPENCEPH_TENTACLE_WORKSPACE
config.trigger_mode      # str — OPENCEPH_TRIGGER_MODE
config.purpose           # str — 从 tentacle.json 读取
config.poll_interval     # int — 从 tentacle.json 读取（秒）
config.batch_threshold   # int — 从 SKILL.md consultation.batchThreshold 读取

# 自定义配置（从 .env 读取的非 OPENCEPH_ 前缀变量）
config.get("ARXIV_CATEGORIES")        # str
config.get("ARXIV_KEYWORDS")          # str
config.get("MY_CUSTOM_VAR", "default")  # 带默认值
```

---

## StateDB

### 初始化

```python
db = StateDB()
# 自动在 data/state.db 创建 SQLite 数据库
```

### is_processed(key) → bool

检查某个 key 是否已被处理。

```python
if not db.is_processed("arxiv:2403.12345"):
    process_paper(paper)
    db.mark_processed("arxiv:2403.12345")
```

### mark_processed(key)

标记 key 为已处理。

### increment_stat(name, value=1)

增加统计计数。

```python
db.increment_stat("total_scanned", 87)
db.increment_stat("agent_activated")  # 默认 +1
```

### get_stat(name) → int

获取统计值。

```python
total = db.get_stat("total_scanned")  # 1247
```

### set_state(key, value)

存储任意状态值（JSON 序列化）。

```python
db.set_state("last_fetch_cursor", "2026-03-26T16:00:00Z")
```

### get_state(key, default=None) → any

获取状态值。

```python
cursor = db.get_state("last_fetch_cursor")
```

---

## load_tools(path) → list

加载 tools.json 文件，返回 OpenAI function 格式的工具列表。自动追加共享工具定义。

```python
from openceph_runtime import load_tools

tools = load_tools("tools/tools.json")
# 返回：自建工具列表 + openceph_web_search + openceph_web_fetch + ...
```
