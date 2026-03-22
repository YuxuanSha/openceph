---
name: skill-tentacle-creator
description: Create and validate new OpenCeph skill_tentacle packages.
version: 1.0.0
metadata:
  openceph:
    emoji: "🛠️"
    trigger_keywords: ["创建触手", "封装触手", "自定义触手", "build tentacle", "make a tentacle"]
    tentacle:
      spawnable: true
      runtime: python
      entry: src/main.py
      default_trigger: "on-demand"
      setup_commands:
        - "python3 -m venv venv"
        - "venv/bin/pip install -r src/requirements.txt"
      requires:
        bins: ["python3"]
        env: ["OPENROUTER_API_KEY"]
      capabilities: ["llm_reasoning", "content_generation", "file_management"]
      infrastructure:
        needsLlm: true
---
# Skill Tentacle Creator

Create, validate, and package new `skill_tentacle` bundles through a guided flow.
