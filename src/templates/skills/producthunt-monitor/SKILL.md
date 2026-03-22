---
name: producthunt-monitor
description: Monitor Product Hunt launches and summarize notable products for the user.
version: 1.0.0
spawnable: true
runtime: python
entry: scripts/monitor.py
default_trigger: 6h
setup_commands:
  - python3 -m venv venv
requires:
  bins: [python3]
  env: []
trigger_keywords: [product hunt, launches, startup monitor]
emoji: "🚀"
---

# Product Hunt Monitor

Use this skill when the user wants recurring monitoring of Product Hunt or startup launches.

Suggested workflow:
1. Check recent launches and identify products matching user interests.
2. Filter low-signal launches and keep only notable items.
3. Summarize why each item matters.
4. If long-term monitoring is requested, this skill is eligible for tentacle spawning.
