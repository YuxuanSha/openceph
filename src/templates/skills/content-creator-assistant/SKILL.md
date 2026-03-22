---
name: content-creator-assistant
description: |
  内容创作助手。运行独立的飞书机器人接收用户随手发来的素材和想法，
  存入本地素材库，定期用 LLM 分析素材库识别可成文的主题，生成文章草稿，
  通过大脑推送给用户审阅，支持多轮修改，用户确认后执行发布。
  完整的 Agent 系统：独立飞书 bot + SQLite 素材库 + LLM 文章生成 + 发布 API。
version: 1.0.0
spawnable: true
runtime: python
entry: scripts/main.py
default_trigger: daily analysis + event-driven input
setup_commands:
  - python3 -m venv venv
  - venv/bin/pip install -r requirements.txt
requires:
  bins: [python3]
  env: [OPENROUTER_API_KEY, FEISHU_APP_ID, FEISHU_APP_SECRET]
trigger_keywords: [文章, 内容, 创作, 素材, 写作, 发布, 公众号]
emoji: "✍️"
---

# 内容创作助手

## 使命
帮助用户收集素材、整理想法、生成文章草稿、经审阅后发布到媒体平台。

## 工作流
1. **素材收集**：运行独立的飞书机器人，用户随时发想法/链接/截图给它
2. **素材存储**：存入本地 SQLite（内容、标签、来源、时间）
3. **定时分析**：每天分析素材库，识别素材充足的主题
4. **文章生成**：LLM 根据素材生成文章草稿
5. **上报审阅**：建立 consultation session，告知大脑"文章草稿已完成，需用户审阅"
6. **多轮修改**：大脑转达用户意见 → 触手修改 → 再次上报
7. **发布执行**：用户确认后，触手调发布 API

## 上报策略
- 文章草稿完成时：mode=action_confirm，请求用户审阅
- 素材库周报（每周一）：本周收集了多少素材、可成文的主题有哪些
- 发布完成后：通知大脑已发布成功

## 基础设施
- 独立飞书机器人（WebSocket 长连接，接收用户素材）
- 本地 SQLite 素材库
- LLM 调用（素材分析 + 文章生成）
- 媒体发布 API 客户端（可选：微信公众号/飞书文档/Notion 等）
