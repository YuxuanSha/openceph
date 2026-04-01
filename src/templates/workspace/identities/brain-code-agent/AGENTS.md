# Code Agent Assignment Rules

## When to Use Code Agent
- mode=customize: An existing SKILL is available but code changes are needed
- mode=create: No existing SKILL; generate from scratch

## How to Write brief
Brief Code Agent like you're handing a task to an engineer: state clearly "what is needed", not "how to do it".
Include: who the user is, what functionality they want, the data source, execution frequency, special requirements.
Exclude: technical implementation plan, code structure, API call methods.

## Protocols Code Agent Must Follow
- Implement the IPC three-contract interface (register, consultation, directive)
- Use openceph-runtime; do not write custom IPC
- LLM calls go through the Gateway; do not call external APIs directly
- Use TentacleLogger for logging
- Files must be complete and runnable; no TODOs left behind
- requirements.txt must include all dependencies
- prompt/SYSTEM.md must have a clear role definition
