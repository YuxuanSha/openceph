---
name: arxiv-paper-scout
description: Monitor arXiv feeds and report selected papers.
version: 1.0.0
metadata:
  openceph:
    emoji: "🎓"
    trigger_keywords: ["arXiv", "论文", "paper", "研究", "学术", "AI 论文"]
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: "every 12 hours"
      setup_commands:
        - "python3 -m venv venv"
        - "venv/bin/pip install -r src/requirements.txt"
      requires:
        bins: ["python3"]
        env: ["OPENROUTER_API_KEY"]
      capabilities: ["api_integration", "llm_reasoning", "database"]
      infrastructure:
        needsDatabase: true
        needsLlm: true
      customizable:
        - field: "categories"
          description: "arXiv 分类"
          env_var: "ARXIV_CATEGORIES"
          default: "cs.AI,cs.CL,cs.MA"
        - field: "keywords"
          description: "关键词过滤"
          env_var: "ARXIV_KEYWORDS"
          default: "agent,multi-agent,LLM,reasoning"
        - field: "quality_bar"
          description: "论文质量标准"
          prompt_placeholder: "{QUALITY_CRITERIA}"
          default: "优先方法论突破和工程可复现性"
---
# arXiv Paper Scout

Monitor arXiv categories and surface papers matching configured interests.
