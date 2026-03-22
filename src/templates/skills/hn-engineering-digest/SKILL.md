---
name: hn-engineering-digest
description: Fetch Hacker News top stories, score engineering relevance with LLM, deduplicate with SQLite, and report outstanding content immediately or in batches.
version: 2.0.0
trigger_keywords:
  - hacker news
  - HN
  - tech digest
  - engineering digest
metadata:
  openceph:
    emoji: 📰
    trigger_keywords:
      - hacker news
      - tech digest
      - engineering digest
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: "every 6 hours"
      setup_commands:
        - pip install -r src/requirements.txt
      requires:
        bins:
          - python3
        env:
          - OPENROUTER_API_KEY
      capabilities:
        - api_integration
        - llm_reasoning
        - database
      infrastructure:
        needsDatabase: true
        needsLlm: true
      customizable:
        - field: min_comments
          description: Minimum comment count threshold; stories below this are filtered out
          env_var: MIN_COMMENTS
          default: "100"
        - field: topics
          description: "comma-separated topics to watch"
          env_var: WATCHED_TOPICS
          default: "rust,go,ai,llm,infrastructure,database,systems,compilers,distributed"
        - field: engineering_focus
          description: "what makes a good engineering post"
          prompt_placeholder: "{ENGINEERING_CRITERIA}"
          default: "Deep technical dives, architecture decisions, benchmarks, novel systems design, lessons learned from production"
---

# HN Engineering Digest

Use this skill when the user wants a curated, LLM-scored engineering digest from Hacker News.

Suggested workflow:
1. Fetch top stories from HN Algolia API on a recurring schedule (every 6 hours by default).
2. Filter posts by minimum comment count and deduplicate via SQLite.
3. Score each new story with an OpenRouter LLM call for engineering relevance.
4. Apply tiered reporting: quality > 0.9 → immediate; quality > 0.6 → batch (>=3 or 24h); else discard.
5. Send a `consultation_request` to brain with scored, summarised items.
6. If long-term monitoring is requested, this skill is eligible for tentacle spawning.
