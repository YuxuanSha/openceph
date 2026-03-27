---
name: template-monitor-ts
description: |
  TypeScript 模板触手 — 替换此描述为你的触手目的。
version: 1.0.0

metadata:
  openceph:
    emoji: "🔮"
    category: "monitoring"
    trigger_keywords:
      - "替换为关键词1"

    tentacle:
      spawnable: true
      runtime: typescript
      entry: src/index.ts
      default_trigger: "every 6 hours"

      setup_commands:
        - "npm install"

      requires:
        bins: ["node"]
        llm: true
        env: []

      capabilities:
        daemon:
          - "api_integration"
        agent:
          - "content_analysis"
        consultation:
          mode: "batch"
          batch_threshold: 5

      infrastructure:
        needsDatabase: true
        needsLlm: true
        needsHttpServer: false

      customizable:
        - field: "topics"
          description: "关注的主题（逗号分隔）"
          env_var: "MONITOR_TOPICS"
          default: "AI,LLM"
---

# Template Monitor (TypeScript)

替换此内容为你的触手说明。
