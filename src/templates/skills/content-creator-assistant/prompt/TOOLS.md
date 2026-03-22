# Content Creator Assistant — Tools Description

## Internal Modules

All tools are Python modules invoked directly (not external API calls or subprocesses).

---

### `MaterialDB` (`src/material_db.py`)

Local SQLite persistence layer for materials and articles.

**Tables**

- `materials(id, source, url, title, content, collected_at, analyzed)`
- `articles(id, title, content, status, created_at, published_at, publish_url)`

**Key methods**

| Method | Description |
|---|---|
| `init()` | Create tables if they do not exist |
| `add_material(source, url, title, content) -> str` | Insert material, return generated `id` |
| `get_unanalyzed_materials() -> list[dict]` | Return all materials where `analyzed=False` |
| `mark_analyzed(material_id)` | Set `analyzed=True` for a material |
| `save_article(title, content) -> str` | Insert article draft with `status="draft"`, return `id` |
| `update_article_status(article_id, status, publish_url=None)` | Update article status and optional publish URL |

---

### `ContentAnalyzer` (`src/analyzer.py`)

LLM-powered analysis via OpenRouter API (`openai/gpt-4o-mini` by default).

**Methods**

| Method | Description |
|---|---|
| `analyze_materials(materials, content_topics) -> dict` | Analyze a batch of materials; return identified content opportunities ranked by potential |
| `generate_article_outline(topic, materials, writing_style) -> str` | Generate a structured article outline for the given topic |

**LLM endpoint**: `https://openrouter.ai/api/v1/chat/completions`
**Auth**: `Authorization: Bearer {OPENROUTER_API_KEY}`

---

### `ArticleWriter` (`src/article_writer.py`)

LLM-powered full article generation via OpenRouter API (`openai/gpt-4o` by default).

**Methods**

| Method | Description |
|---|---|
| `write_article(outline, materials, writing_style) -> dict` | Generate full article from outline; returns `{"title": str, "content": str}` |

---

### `Publisher` (`src/publisher.py`)

Publishing coordinator that routes to the correct platform.

**Methods**

| Method | Description |
|---|---|
| `publish(article: dict) -> str` | Publish article to configured platform; returns publish URL |

**Platforms**

- `feishu_doc` — calls `FeishuBot.create_doc(title, content)`, returns doc URL
- `feishu_message` — calls `FeishuBot.send_message(chat_id, content)`, returns confirmation string

---

### `FeishuBot` (`src/feishu_bot.py`)

Feishu (Lark) API client using `requests`.

**Methods**

| Method | Description |
|---|---|
| `get_tenant_access_token() -> str` | Fetch or return cached tenant access token (2h TTL) |
| `send_message(chat_id, text) -> bool` | Send a text message to a Feishu chat |
| `create_doc(title, content) -> str` | Create a Feishu document; return the doc URL |

**API base**: `https://open.feishu.cn/open-apis/`
**Auth**: `tenant_access_token` cached in memory, refreshed when expired

---

### `IpcClient` (`src/ipc_client.py`)

OpenCeph IPC protocol implementation (Unix socket, newline-delimited JSON).

**Contracts**

| Contract | Method | Description |
|---|---|---|
| 1. Register | `register(purpose, runtime)` | Announce tentacle to brain on startup |
| 2. Report | `consultation_request(mode, items, summary)` | Send batch or action_confirm report to brain |
| 3. Directives | `on_directive(handler)` | Register callback for incoming directives |

**Supported `mode` values**

- `"batch"` — informational batch report; brain may surface to user
- `"action_confirm"` — requires explicit user confirmation before action is taken

---

## External APIs (via `requests`)

### Hacker News (Algolia API)

- **Endpoint**: `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30`
- **Auth**: None required
- **Returns**: Stories with `title`, `url`, `points`, `num_comments`, `author`, `created_at`

### OpenRouter Chat Completions

- **Endpoint**: `https://openrouter.ai/api/v1/chat/completions`
- **Auth**: `Authorization: Bearer {OPENROUTER_API_KEY}`
- **Models used**: `openai/gpt-4o-mini` (analysis), `openai/gpt-4o` (article writing)

### Feishu (Lark) Open Platform

- **Base URL**: `https://open.feishu.cn/open-apis/`
- **Token endpoint**: `POST /auth/v3/tenant_access_token/internal`
- **Message endpoint**: `POST /im/v1/messages`
- **Doc endpoint**: `POST /docx/v1/documents`
