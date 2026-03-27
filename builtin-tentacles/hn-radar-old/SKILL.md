---
name: hn-radar
description: Monitor Hacker News posts and report relevant items.
version: 1.0.0
metadata:
  openceph:
    emoji: "📡"
    trigger_keywords: ["Hacker News", "HN", "技术新闻", "开源动态", "tech news"]
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
        env: []
      capabilities:
        daemon:
          - "api_integration"
          - "database"
        agent:
          - "content_analysis"
        consultation:
          mode: "batch"
          batch_threshold: 3
      infrastructure:
        needsDatabase: true
        needsLlm: false
      customizable:
        - field: "topics"
          description: "关注主题关键词"
          env_var: "HN_TOPICS"
          default: "AI,LLM,agent,startup"
        - field: "min_score"
          description: "最低 HN 分数"
          env_var: "HN_MIN_SCORE"
          default: "50"
        - field: "min_comments"
          description: "最低评论数"
          env_var: "HN_MIN_COMMENTS"
          default: "20"
        - field: "use_llm_filter"
          description: "是否启用 LLM 辅助过滤（需要 OPENROUTER_API_KEY）"
          env_var: "USE_LLM_FILTER"
          default: "false"
        - field: "llm_filter_criteria"
          description: "额外过滤标准"
          prompt_placeholder: "{LLM_FILTER_CRITERIA}"
          default: "优先具体工程实践，排除纯发布新闻"
---
# HN Radar

Monitor Hacker News, deduplicate items, and report worthy findings in batches.
