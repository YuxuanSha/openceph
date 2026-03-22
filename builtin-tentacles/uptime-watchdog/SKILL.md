---
name: uptime-watchdog
description: Monitor websites and APIs for downtime and latency regressions.
version: 1.0.0
metadata:
  openceph:
    emoji: "🏥"
    trigger_keywords: ["监控", "uptime", "可用性", "宕机", "网站挂了", "API 监控"]
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: "every 5 minutes"
      setup_commands:
        - "python3 -m venv venv"
        - "venv/bin/pip install -r src/requirements.txt"
      requires:
        bins: ["python3"]
        env: []
      capabilities: ["api_integration", "database"]
      infrastructure:
        needsDatabase: true
        needsLlm: false
      customizable:
        - field: "endpoints"
          description: "监控 URL 列表"
          env_var: "WATCH_ENDPOINTS"
          default: "[]"
        - field: "check_interval"
          description: "检查间隔秒数"
          env_var: "CHECK_INTERVAL_SECONDS"
          default: "300"
---
# Uptime Watchdog

Monitor configured HTTP endpoints and alert immediately on failures.
