---
name: hn-radar
description: |
  通用 Hacker News 监控触手。支持 6 种数据源，LLM 智能过滤，批量汇报。
  默认抓取最新帖子，每条过 LLM 筛选，值得的上报 Brain 推送给用户。
version: 1.4.0
metadata:
  openceph:
    emoji: "📡"
    category: "monitoring"
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
          description: "关注主题关键词，用于 Algolia 搜索和 LLM 判断（逗号分隔）"
          env_var: "HN_TOPICS"
          default: "AI,LLM,agent,startup"
        - field: "feeds"
          description: "启用的数据源：newest,frontpage,ask,show,search（逗号分隔）"
          env_var: "HN_FEEDS"
          default: "newest"
        - field: "fetch_count"
          description: "每个数据源每次抓取数量（RSS 最大 100）"
          env_var: "HN_FETCH_COUNT"
          default: "50"
        - field: "min_score"
          description: "最低分数（0=不过滤，交给 LLM 判断）"
          env_var: "HN_MIN_SCORE"
          default: "0"
        - field: "min_comments"
          description: "最低评论数（0=不过滤）"
          env_var: "HN_MIN_COMMENTS"
          default: "0"
        - field: "use_llm_filter"
          description: "是否启用 LLM 智能过滤（推荐开启）"
          env_var: "USE_LLM_FILTER"
          default: "true"
        - field: "llm_filter_criteria"
          description: "LLM 过滤标准（自然语言描述）"
          prompt_placeholder: "{LLM_FILTER_CRITERIA}"
          default: "筛选具有工程价值的内容：架构设计、系统优化、开源项目、技术深度分析。排除纯新闻发布、招聘帖、低质量讨论。"
        - field: "batch_size"
          description: "批量汇报阈值（首次运行立即汇报）"
          env_var: "BATCH_SIZE"
          default: "3"
        - field: "interval"
          description: "扫描间隔（秒）"
          env_var: "HN_INTERVAL_SECONDS"
          default: "7200"
---
# HN Radar

通用 Hacker News 监控触手。默认抓取最新帖子，每条过 LLM 智能筛选，值得的上报 Brain 推送给用户。

## 开箱即用
- 默认数据源：`newest`（所有最新帖子，无分数门槛）
- 默认过滤：LLM 智能判断（`USE_LLM_FILTER=true`）
- 部署后立即工作，无需额外配置

## 自定义模式
- 传统模式：`USE_LLM_FILTER=false` + `HN_MIN_SCORE=50` + `HN_MIN_COMMENTS=20`
- 多数据源：`HN_FEEDS=newest,frontpage,search`
- 高频扫描：`HN_INTERVAL_SECONDS=60`
