# Content Creator Assistant — Deployment Guide

## Overview

This tentacle collects content materials from public sources (Hacker News, etc.), uses LLM to
analyze topics and generate article drafts, then asks for explicit user approval via `action_confirm`
before publishing to Feishu. Publishing never happens automatically.

## Environment Requirements

- Python 3.10+
- OpenCeph runtime with IPC socket
- OpenRouter API key (for LLM calls)
- Feishu app credentials (for bot integration)

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENCEPH_SOCKET_PATH` | Yes | — | IPC socket path (set by OpenCeph runtime) |
| `OPENCEPH_TENTACLE_ID` | Yes | — | Tentacle identifier (set by OpenCeph runtime) |
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key for LLM calls |
| `FEISHU_APP_ID` | Yes | — | Feishu app ID for bot integration |
| `FEISHU_APP_SECRET` | Yes | — | Feishu app secret for bot integration |
| `PUBLISH_PLATFORM` | No | `feishu_doc` | Publishing target: `feishu_doc` or `feishu_message` |
| `FEISHU_CHAT_ID` | No | — | Required when `PUBLISH_PLATFORM=feishu_message` |
| `OPENCEPH_TRIGGER_MODE` | No | `self` | `self` for self-scheduling, `external` for brain-triggered |
| `COLLECT_INTERVAL` | No | `24h` | Interval between material collection cycles |

## Deployment Steps

1. Ensure the skill_tentacle package is registered with OpenCeph.
2. Configure environment variables in your `.env` or OpenCeph skill config.
3. Install dependencies:
   ```bash
   pip install -r src/requirements.txt
   ```
4. The tentacle will be spawned automatically by OpenCeph when triggered.

## Start Command

```bash
# Spawned by OpenCeph runtime:
python3 src/main.py

# Dry-run mode (no IPC, no network, prints config):
python3 src/main.py --dry-run
```

## Personalization

This tentacle supports prompt-level personalization through placeholders in `prompt/SYSTEM.md`:

- **`{CONTENT_TOPICS}`** — Topics to collect and write about. Guides LLM analysis and article generation.
- **`{WRITING_STYLE}`** — Writing style for generated articles (e.g., "technical, in-depth", "casual").

These are set via the `content_topics` and `writing_style` customizable fields in `SKILL.md`.

## Architecture

```
main.py                  — Entry point, scheduler, directive handler
├── material_db.py       — SQLite store for materials and articles
├── ipc_client.py        — OpenCeph IPC protocol (register / report / directives)
├── analyzer.py          — LLM-powered content analysis and outline generation
├── article_writer.py    — LLM-powered full article generation
├── publisher.py         — Publishing coordinator (Feishu doc / message)
└── feishu_bot.py        — Feishu API client (token, send_message, create_doc)
```

## action_confirm Flow

```
[Tentacle]                          [Brain / User]
    |                                     |
    |-- consultation_request (action_confirm) -->
    |   content: article title + preview        |
    |   action: { type: publish_article, ... }  |
    |   requires_confirmation: true             |
    |                                     |
    |<-- directive: action_approved / action_rejected --
    |                                     |
    |-- (if approved) publish via Feishu -->
    |-- consultation_request (batch, publish result) -->
```

## Common Issues

| Symptom | Cause | Fix |
|---|---|---|
| `ConnectionRefusedError` on startup | IPC socket not ready | Ensure OpenCeph brain is running |
| LLM calls failing | Invalid API key | Check `OPENROUTER_API_KEY` in `.env` |
| Feishu token errors | Wrong app credentials | Verify `FEISHU_APP_ID` and `FEISHU_APP_SECRET` |
| No materials collected | Network access blocked | Check firewall; HN API requires HTTPS |
| Article never published | Expected behavior | Publishing requires explicit `action_approved` directive |
