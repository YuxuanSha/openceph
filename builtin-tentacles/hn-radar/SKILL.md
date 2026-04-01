---
name: hn-radar
description: |
  General-purpose Hacker News monitoring tentacle. Supports 6 data sources, LLM-powered smart filtering, and batch reporting.
  Fetches latest posts by default, runs each through LLM screening, and reports worthy items to Brain for user notification.
version: 1.4.0
metadata:
  openceph:
    emoji: "📡"
    category: "monitoring"
    trigger_keywords: ["Hacker News", "HN", "tech news", "open source updates", "tech news"]
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: "every 2 hours"
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
          - "llm_filter"
        consultation:
          mode: "batch"
          batch_threshold: 3
      infrastructure:
        needsDatabase: true
        needsLlm: true
      customizable:
        - field: "topics"
          description: "Topics of interest for Algolia search and LLM evaluation (comma-separated)"
          env_var: "HN_TOPICS"
          default: "AI,LLM,agent,startup"
        - field: "feeds"
          description: "Enabled data sources: newest,frontpage,ask,show,search (comma-separated)"
          env_var: "HN_FEEDS"
          default: "newest"
        - field: "fetch_count"
          description: "Number of items to fetch per data source per run (RSS max 100)"
          env_var: "HN_FETCH_COUNT"
          default: "50"
        - field: "min_score"
          description: "Minimum score (0 = no filtering, defer to LLM)"
          env_var: "HN_MIN_SCORE"
          default: "0"
        - field: "min_comments"
          description: "Minimum comment count (0 = no filtering)"
          env_var: "HN_MIN_COMMENTS"
          default: "0"
        - field: "use_llm_filter"
          description: "Enable LLM-powered smart filtering (recommended)"
          env_var: "USE_LLM_FILTER"
          default: "true"
        - field: "llm_filter_criteria"
          description: "LLM filtering criteria (natural language description)"
          prompt_placeholder: "{LLM_FILTER_CRITERIA}"
          default: "Select content with engineering value: architecture design, system optimization, open source projects, in-depth technical analysis. Exclude pure news announcements, job postings, and low-quality discussions."
        - field: "batch_size"
          description: "Batch reporting threshold (reports immediately on first run)"
          env_var: "BATCH_SIZE"
          default: "3"
        - field: "interval"
          description: "Scan interval (seconds)"
          env_var: "HN_INTERVAL_SECONDS"
          default: "7200"
---
# HN Radar

General-purpose Hacker News monitoring tentacle. Fetches latest posts by default, runs each through LLM-powered smart screening, and reports worthy items to Brain for user notification.

## Works Out of the Box
- Default data source: `newest` (all latest posts, no score threshold)
- Default filtering: LLM-powered smart evaluation (`USE_LLM_FILTER=true`)
- Works immediately after deployment, no additional configuration needed

## Custom Modes
- Traditional mode: `USE_LLM_FILTER=false` + `HN_MIN_SCORE=50` + `HN_MIN_COMMENTS=20`
- Multiple data sources: `HN_FEEDS=newest,frontpage,search`
- High-frequency scanning: `HN_INTERVAL_SECONDS=60`
