---
name: daily-digest-curator
description: Curate pending findings into a structured daily digest.
version: 1.0.0
metadata:
  openceph:
    emoji: "📋"
    trigger_keywords: ["每日简报", "晨报", "daily digest", "信息汇总", "早报"]
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: "cron:0 9 * * *"
      setup_commands:
        - "python3 -m venv venv"
        - "venv/bin/pip install -r src/requirements.txt"
      requires:
        bins: ["python3"]
        env: ["OPENROUTER_API_KEY"]
      capabilities: ["llm_reasoning", "content_generation"]
      infrastructure:
        needsLlm: true
      customizable:
        - field: "digest_style"
          description: "简报风格"
          prompt_placeholder: "{DIGEST_STYLE}"
          default: "简洁高密度，每条一句话摘要 + 链接"
        - field: "digest_time"
          description: "简报发送 cron"
          env_var: "DIGEST_CRON"
          default: "0 9 * * *"
---
# Daily Digest Curator

Collect pending findings and reorganize them into a concise digest message.
