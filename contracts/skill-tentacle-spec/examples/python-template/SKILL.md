---
name: template-monitor
description: |
  Template tentacle — replace this description with your tentacle's purpose.
  Spawn this tentacle when the user wants {your tentacle's functionality}.
version: 1.0.0

metadata:
  openceph:
    emoji: "🔮"
    category: "monitoring"
    trigger_keywords:
      - "replace with keyword 1"
      - "replace with keyword 2"

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
        llm: true
        env: []

      capabilities:
        daemon:
          - "api_integration"
          - "database"
        agent:
          - "content_analysis"
        consultation:
          mode: "batch"
          batch_threshold: 5

      infrastructure:
        needsDatabase: true
        needsLlm: true
        needsHttpServer: false

      customizable:
        - field: "topics"
          description: "Topics of interest (comma-separated)"
          env_var: "MONITOR_TOPICS"
          default: "AI,LLM,agent"
        - field: "quality_bar"
          description: "Content quality judgment criteria"
          prompt_placeholder: "{QUALITY_CRITERIA}"
          default: "Has practical value, not pure news or advertisements"
---

# Template Monitor

Replace this content with your tentacle's description.
