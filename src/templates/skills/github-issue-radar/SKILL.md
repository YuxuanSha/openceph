---
name: github-issue-radar
description: Monitor specified GitHub repositories for new issues and PRs, classify them with LLM reasoning, and report relevant findings to the Brain.
version: 2.0.0
trigger_keywords:
  - github
  - issue
  - PR
  - repository
  - monitor
metadata:
  openceph:
    emoji: 🔍
    trigger_keywords:
      - github issue
      - repo monitor
      - issue radar
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
          - GITHUB_TOKEN
          - OPENROUTER_API_KEY
      capabilities:
        - api_integration
        - llm_reasoning
        - database
      infrastructure:
        needsDatabase: true
        needsLlm: true
      customizable:
        - field: repos
          description: Comma-separated list of GitHub repositories to monitor (owner/repo format)
          env_var: WATCHED_REPOS
          default: ""
          example: "anthropics/claude-code,openai/openai-python"
        - field: focus_areas
          description: Description of the user's technical focus areas used to classify issue relevance
          prompt_placeholder: "{FOCUS_AREAS}"
          default: "general software engineering"
          example: "Rust systems programming, LLM inference optimization, security vulnerabilities"
        - field: poll_interval
          description: Polling interval in minutes
          env_var: POLL_INTERVAL_MINUTES
          default: "30"
          example: "60"
---

# GitHub Issue Radar

Monitor specified GitHub repositories for new issues and PRs, classify them using LLM reasoning, and report relevant findings to the Brain with smart batching.

## How It Works

1. Poll GitHub REST API on a configurable interval (default: 30 minutes)
2. Fetch newly created issues and PRs from watched repositories with pagination
3. Filter already-seen issues via SQLite deduplication database
4. Classify each new issue using OpenRouter LLM (relevance, category, urgency)
5. Apply report strategy: immediate for critical/security, batch for normal findings, discard for noise
6. Report to Brain via IPC `consultation_request`

## Trigger Modes

- **self** (default): Autonomous timed polling
- **external**: Wait for Brain's `run_now` directive before executing a cycle

## Required Environment Variables

| Variable | Description |
|----------|-------------|
| `GITHUB_TOKEN` | GitHub Personal Access Token |
| `OPENROUTER_API_KEY` | OpenRouter API key for LLM classification |
| `WATCHED_REPOS` | Comma-separated list of repos to monitor (owner/repo) |
| `POLL_INTERVAL_MINUTES` | Polling interval in minutes (default: 30) |
| `FOCUS_AREAS` | User's technical focus areas for relevance classification |
