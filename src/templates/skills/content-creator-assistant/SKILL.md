---
name: content-creator-assistant
description: 内容创作助手 — 收集素材、分析话题、生成文章草稿、等待用户确认后发布
version: 2.0.0
trigger_keywords:
  - content
  - writing
  - blog
  - article
  - publish
metadata:
  openceph:
    emoji: ✍️
    trigger_keywords:
      - content creator
      - writing assistant
      - content intelligence
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: self
      setup_commands:
        - pip install -r src/requirements.txt
      requires:
        bins:
          - python3
        env:
          - OPENROUTER_API_KEY
          - FEISHU_APP_ID
          - FEISHU_APP_SECRET
      capabilities:
        - api_integration
        - llm_reasoning
        - database
        - content_generation
        - external_bot
        - action_execution
      infrastructure:
        needsDatabase: true
        needsLlm: true
        needsExternalBot: true
      customizable:
        - field: content_topics
          description: "topics to collect content about"
          prompt_placeholder: "{CONTENT_TOPICS}"
          default: "AI, software engineering, technology trends"
          example: "AI, LLMs, Rust, distributed systems"
        - field: writing_style
          description: "article writing style"
          prompt_placeholder: "{WRITING_STYLE}"
          default: "technical, clear, in-depth"
          example: "casual and approachable, academic, concise tutorial"
        - field: publish_platform
          description: "where to publish articles"
          env_var: PUBLISH_PLATFORM
          default: "feishu_doc"
          example: "feishu_doc, feishu_message"
---

# Content Creator Assistant (内容创作助手)

一个完整的 Agent 系统 skill_tentacle，自动收集内容素材、使用 LLM 分析热点话题、生成文章草稿，
通过 action_confirm 流程等待用户明确批准后方可发布。**永不自动发布。**

## 工作流

1. **每日素材收集**：从 Hacker News 等公开源抓取素材并存入本地数据库
2. **每周分析**（周一）：LLM 分析积累的素材，识别最佳写作话题
3. **文章生成**：为优质话题生成完整文章草稿（outline → full article）
4. **ACTION_CONFIRM**：通过 `mode: "action_confirm"` 向大脑汇报草稿，等待用户明确批准
5. **发布**：仅在用户批准后，通过 Feishu Bot 发布文章

## 上报策略

- **action_confirm 模式**：每篇文章草稿就绪后单独上报，等待用户批准
- **批量摘要**：每周分析结果以 batch 模式汇报（不触发发布，仅信息同步）
- **CRITICAL**：未经用户明确确认，绝对不发布任何内容

## 指令支持

| 指令 | 行为 |
|---|---|
| `run_now` | 立即触发一次素材收集周期 |
| `action_approved` | 用户批准发布，执行发布操作 |
| `action_rejected` | 用户拒绝发布，标记文章为 rejected |
| `pause` | 暂停定时任务 |
| `resume` | 恢复定时任务 |
| `kill` | 优雅退出 |
