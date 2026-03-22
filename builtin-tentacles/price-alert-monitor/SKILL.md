---
name: price-alert-monitor
description: Monitor configured targets for price changes.
version: 1.0.0
metadata:
  openceph:
    emoji: "💰"
    trigger_keywords: ["价格", "比价", "降价", "涨价", "price alert", "定价变化"]
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
        env: []
      capabilities: ["api_integration", "database"]
      infrastructure:
        needsDatabase: true
      customizable:
        - field: "watch_items"
          description: "监控项 JSON"
          env_var: "WATCH_ITEMS_JSON"
          default: "[]"
---
# Price Alert Monitor

Track configured URLs or APIs and report price changes against the saved baseline.
