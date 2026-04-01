# LLM Gateway API Complete Reference

**File location:** `contracts/skill-tentacle-spec/reference/llm-gateway-api.md`
**Purpose:** Complete specification of the HTTP API for tentacles to call LLMs

---

## 1. Overview

LLM Gateway is a local HTTP service started within the Brain main process, providing unified model invocation capabilities to all tentacles. It is compatible with the OpenAI API format.

Tentacles **do not call external LLM APIs directly**; all model calls must go through the LLM Gateway.

---

## 2. Connection Information

```
URL:   Environment variable OPENCEPH_LLM_GATEWAY_URL   (e.g., http://127.0.0.1:18792)
Token: Environment variable OPENCEPH_LLM_GATEWAY_TOKEN
ID:    Environment variable OPENCEPH_TENTACLE_ID
```

These three environment variables are automatically injected into `.env` by Brain when the tentacle starts. Tentacle code reads them via `os.environ`.

---

## 3. Endpoint List

| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | Chat Completions (core endpoint) |
| GET | `/v1/models` | List available models |
| GET | `/health` | Health check |

---

## 4. Chat Completions

### Request

```
POST {OPENCEPH_LLM_GATEWAY_URL}/v1/chat/completions

Headers:
  Content-Type: application/json
  Authorization: Bearer {OPENCEPH_LLM_GATEWAY_TOKEN}
  X-Tentacle-Id: {OPENCEPH_TENTACLE_ID}
  X-Request-Id: {Optional, UUID, used for log correlation}
```

### Request Body

```json
{
  "messages": [
    { "role": "system", "content": "You are a paper analysis expert..." },
    { "role": "user", "content": "Analyze the methodology of this paper..." }
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
        "description": "Search arXiv papers",
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

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `messages` | Yes | array | Message list |
| `model` | No | string | Model selection (see table below), defaults to `"default"` |
| `temperature` | No | number | 0.0-2.0, defaults to configured value |
| `max_tokens` | No | number | Maximum output tokens |
| `stream` | No | boolean | Whether to enable streaming output, defaults to `false` |
| `tools` | No | array | Tool definition list (OpenAI function calling format) |
| `tool_choice` | No | string/object | `"auto"` / `"none"` / specific tool |

### model Field Resolution

| Value | Behavior |
|-------|----------|
| `"default"` or omitted | Uses `tentacle.model.primary` from openceph.json |
| `"fallback"` | Uses `tentacle.model.fallbacks[0]` |
| Specific ID (e.g., `"openrouter/google/gemini-3-flash-preview"`) | Uses the specified model |

**Recommendation:** Always use `"default"` or omit the field, and let the configuration file determine model selection.

### Response Body (Non-Streaming)

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
        "content": "This paper proposes...",
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

### Response with tool_calls

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

When `finish_reason` is `"tool_calls"`, the tentacle should execute the corresponding tool, then append the result as a `tool` role message to the messages and continue calling.

### tool_result Message Format (appended to messages)

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"results\": [...]}"
}
```

---

## 5. Streaming (SSE)

```
POST {OPENCEPH_LLM_GATEWAY_URL}/v1/chat/completions
Body: { ..., "stream": true }
```

The response is Server-Sent Events:

```
data: {"id":"chatcmpl-xxx","choices":[{"delta":{"role":"assistant"},"index":0}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":"This"},"index":0}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":" paper"},"index":0}]}

data: {"id":"chatcmpl-xxx","choices":[{"delta":{"content":" proposes"},"index":0}]}

data: [DONE]
```

---

## 6. Model List

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

## 7. Health Check

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

## 8. Error Responses

```json
{
  "error": {
    "message": "Rate limit exceeded for tentacle t_arxiv_scout",
    "type": "rate_limit_error",
    "code": 429
  }
}
```

| HTTP Status Code | Reason |
|-----------------|--------|
| 400 | Malformed request |
| 401 | Invalid token |
| 403 | Tentacle not registered or already stopped |
| 429 | Rate limit |
| 500 | Gateway internal error |
| 502 | Upstream LLM provider unavailable |

---

## 9. Python Call Examples

### Using openceph-runtime (Recommended)

```python
from openceph_runtime import LlmClient

llm = LlmClient()
response = llm.chat([
    {"role": "system", "content": "You are a paper analysis expert"},
    {"role": "user", "content": "Analyze this paper..."},
], temperature=0.3)

print(response.content)
```

### Using requests (Low-Level)

```python
import os, requests

resp = requests.post(
    f"{os.environ['OPENCEPH_LLM_GATEWAY_URL']}/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {os.environ['OPENCEPH_LLM_GATEWAY_TOKEN']}",
        "X-Tentacle-Id": os.environ["OPENCEPH_TENTACLE_ID"],
    },
    json={
        "messages": [{"role": "user", "content": "Analyze..."}],
        "temperature": 0.3,
    },
    timeout=120,
)
data = resp.json()
print(data["choices"][0]["message"]["content"])
```

### Using OpenAI Python SDK

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
    messages=[{"role": "user", "content": "Analyze..."}],
)
print(response.choices[0].message.content)
```
