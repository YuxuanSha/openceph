---
name: github-release-watcher
description: Monitor GitHub repositories for new releases and tags.
version: 1.0.0
metadata:
  openceph:
    emoji: "📦"
    trigger_keywords: ["GitHub Release", "版本更新", "依赖更新", "新版本", "changelog"]
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
        env: ["GITHUB_TOKEN"]
      capabilities: ["api_integration", "database"]
      infrastructure:
        needsDatabase: true
      customizable:
        - field: "repos"
          description: "监控仓库列表"
          env_var: "WATCH_REPOS"
          default: "openai/openai-node,vercel/next.js"
        - field: "include_prereleases"
          description: "是否包含预发布"
          env_var: "INCLUDE_PRERELEASES"
          default: "false"
---
# GitHub Release Watcher

Monitor configured GitHub repositories and surface new releases with short summaries.
