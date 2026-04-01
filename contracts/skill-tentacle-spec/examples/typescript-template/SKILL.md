---
name: template-monitor-ts
description: |
  TypeScript template tentacle — replace this description with your tentacle's purpose.
version: 1.0.0

metadata:
  openceph:
    emoji: "🔮"
    category: "monitoring"
    trigger_keywords:
      - "replace with keyword 1"

    tentacle:
      spawnable: true
      runtime: typescript
      entry: src/index.ts
      default_trigger: "every 6 hours"

      setup_commands:
        - "npm install"

      requires:
        bins: ["node"]
        llm: true
        env: []

      capabilities:
        daemon:
          - "api_integration"
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
          default: "AI,LLM"
---

# Template Monitor (TypeScript)

Replace this content with your tentacle's description.
