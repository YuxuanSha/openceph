---
name: rss-monitor
description: Monitor RSS or Atom feeds, deduplicate new items, and surface high-signal updates to the user.
version: 1.0.0
spawnable: true
runtime: python
entry: scripts/monitor.py
default_trigger: 3h
setup_commands:
  - python3 -m venv venv
requires:
  bins: [python3]
  env: []
trigger_keywords: [rss, atom, blog monitor, feed watcher]
emoji: "📰"
---

# RSS Monitor

Use this skill when the user wants long-running monitoring of one or more RSS or Atom feeds.

Suggested workflow:
1. Poll configured feeds on a fixed interval.
2. Deduplicate already seen entries by link or guid.
3. Batch routine updates and escalate urgent items immediately.
4. Ask for confirmation before taking actions derived from feed content.
