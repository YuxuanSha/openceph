---
name: template-monitor
description: |
  模板触手 — 替换此描述为你的触手目的。
  当用户想要{你的触手功能}时孵化此触手。
version: 1.0.0

metadata:
  openceph:
    emoji: "🔮"
    category: "monitoring"
    trigger_keywords:
      - "替换为关键词1"
      - "替换为关键词2"

    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: "every 6 hours"

      setup_commands:
        - "python3 -m venv venv"
        - "venv/bin/pip install -r src/requirements.txt"

      requires:
        bins: ["python3"]
        llm: true
        env: []

      capabilities:
        daemon:
          - "api_integration"
          - "database"
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
          default: "AI,LLM,agent"
        - field: "quality_bar"
          description: "内容质量判断标准"
          prompt_placeholder: "{QUALITY_CRITERIA}"
          default: "有实际价值，不是纯新闻或广告"
---

# Template Monitor

替换此内容为你的触手说明。
