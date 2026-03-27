# LLM Gateway API 完整参考

**文件位置：** `contracts/skill-tentacle-spec/reference/llm-gateway-api.md`  
**用途：** 触手调用 LLM 的 HTTP API 完整规范

---

## 1. 概述

LLM Gateway 是 Brain 主进程内启动的本地 HTTP 服务，向所有触手提供统一的模型调用能力。兼容 OpenAI API 格式。

触手**不直接调用外部 LLM API**，所有模型调用必须通过 LLM Gateway。

---

## 2. 连接信息

```
URL:   环境变量 OPENCEPH_LLM_GATEWAY_URL   （如 http://127.0.0.1:18792）
Token: 环境变量 OPENCEPH_LLM_GATEWAY_TOKEN
ID:    环境变量 OPENCEPH_TENTACLE_ID
```

这三个环境变量在触手启动时由 Brain 自动注入 `.env`，触手代码通过 `os.environ` 读取。

---

## 3. 端点列表

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | Chat Completions（核心端点） |
| GET | `/v1/models` | 列出可用模型 |
| GET | `/health` | 健康检查 |

---

## 4. Chat Completions

### 请求

```
POST {OPENCEPH_LLM_GATEWAY_URL}/v1/chat/completions

Headers:
  Content-Type: application/json
  Authorization: Bearer {OPENCEPH_LLM_GATEWAY_TOKEN}
  X-Tentacle-Id: {OPENCEPH_TENTACLE_ID}
  X-Request-Id: {可选，UUID，用于日志关联}
```

### 请求体

```json
{
  "messages": [
    { "role": "system", "content": "你是论文分析专家..." },
    { "role": "user", "content": "分析这篇论文的方法论..." }
  ],
  "model": "default",
  "temperature": 0.3,
  "max_tokens": 4096,
  "stream": false,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "search_arxiv",
        "description": "搜索 arXiv 论文",
        "parameters": {
          "type": "object",
          "properties": {
            "query": { "type": "string" }
          },
          "required": ["query"]
        }
      }
    }
  ]
}
```

| 字段 | 必须 | 类型 | 说明 |
|------|------|------|------|
| `messages` | ✅ | array | 消息列表 |
| `model` | ❌ | string | 模型选择（见下表），默认 `"default"` |
| `temperature` | ❌ | number | 0.0-2.0，默认使用配置值 |
| `max_tokens` | ❌ | number | 最大输出 token |
| `stream` | ❌ | boolean | 是否流式输出，默认 `false` |
| `tools` | ❌ | array | 工具定义列表（OpenAI function calling 格式） |
| `tool_choice` | ❌ | string/object | `"auto"` / `"none"` / 指定工具 |

### model 字段解析

| 值 | 行为 |
|----|------|
| `"default"` 或省略 | 使用 openceph.json 中 `tentacle.model.primary` |
| `"fallback"` | 使用 `tentacle.model.fallbacks[0]` |
| 具体 ID（如 `"openrouter/google/gemini-3-flash-preview"`） | 使用指定模型 |

**建议：** 始终使用 `"default"` 或省略，让配置文件决定模型选择。

### 响应体（非流式）

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1711468800,
  "model": "google/gemini-3-flash-preview",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "这篇论文提出了...",
        "tool_calls": null
      },
      "finish_reason": "stop"
    }
  ],
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
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "search_arxiv",
              "arguments": "{\"query\": \"multi-agent reinforcement learning\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

当 `finish_reason` 为 `"tool_calls"` 时，触手应执行对应工具，然后将结果作为 `tool` role 消息追加到 messages 中继续调用。

### tool_result 消息格式（追加到 messages）

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"results\": [...]}"
}
```

---

## 5. Streaming（SSE）

```
POST {OPENCEPH_LLM_GATEWAY_URL}/v1/chat/completions
Body: { ..., "stream": true }
```

响应为 Server-Sent Events：

```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"role":"assistant"},"index":0}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"这篇"},"index":0}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"论文"},"index":0}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"提出了"},"index":0}]}

data: [DONE]
```

---

## 6. 模型列表

```
GET {OPENCEPH_LLM_GATEWAY_URL}/v1/models
```

```json
{
  "object": "list",
  "data": [
    {
      "id": "openrouter/google/gemini-3-flash-preview",
      "object": "model",
      "created": 1711468800,
      "owned_by": "openrouter"
    }
  ]
}
```

---

## 7. 健康检查

```
GET {OPENCEPH_LLM_GATEWAY_URL}/health
```

```json
{
  "status": "ok",
  "model": "google/gemini-3-flash-preview",
  "uptime_seconds": 3600
}
```

---

## 8. 错误响应

```json
{
  "error": {
    "message": "Rate limit exceeded for tentacle t_arxiv_scout",
    "type": "rate_limit_error",
    "code": 429
  }
}
```

| HTTP 状态码 | 原因 |
|------------|------|
| 400 | 请求格式错误 |
| 401 | Token 无效 |
| 403 | 触手未注册或已停止 |
| 429 | 速率限制 |
| 500 | Gateway 内部错误 |
| 502 | 上游 LLM provider 不可用 |

---

## 9. Python 调用示例

### 使用 openceph-runtime（推荐）

```python
from openceph_runtime import LlmClient

llm = LlmClient()
response = llm.chat([
    {"role": "system", "content": "你是论文分析专家"},
    {"role": "user", "content": "分析这篇论文..."},
], temperature=0.3)

print(response.content)
```

### 使用 requests（底层）

```python
import os, requests

resp = requests.post(
    f"{os.environ['OPENCEPH_LLM_GATEWAY_URL']}/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {os.environ['OPENCEPH_LLM_GATEWAY_TOKEN']}",
        "X-Tentacle-Id": os.environ["OPENCEPH_TENTACLE_ID"],
    },
    json={
        "messages": [{"role": "user", "content": "分析..."}],
        "temperature": 0.3,
    },
    timeout=120,
)
data = resp.json()
print(data["choices"][0]["message"]["content"])
```

### 使用 OpenAI Python SDK

```python
from openai import OpenAI
import os

client = OpenAI(
    base_url=os.environ["OPENCEPH_LLM_GATEWAY_URL"],
    api_key=os.environ["OPENCEPH_LLM_GATEWAY_TOKEN"],
    default_headers={"X-Tentacle-Id": os.environ["OPENCEPH_TENTACLE_ID"]},
)

response = client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "分析..."}],
)
print(response.choices[0].message.content)
```
