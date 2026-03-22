# SKILL Package Guide

Create custom SKILL blueprints for OpenCeph. SKILLs provide templates that guide Claude Code when generating tentacle Agent systems.

## What is a SKILL?

A SKILL is a **blueprint**, not a ready-to-run program. When a user's request matches a SKILL's trigger keywords, the Brain reads the SKILL and passes it as context to Claude Code, which then generates a customized, fully functional tentacle Agent system.

Key distinction:
- **SKILL** = blueprint + reference code (lives in `~/.openceph/skills/`)
- **Tentacle** = running Agent system generated from a SKILL (lives in `~/.openceph/tentacles/`)

## Directory Structure

```
~/.openceph/skills/my-skill/
├── SKILL.md              # Required: frontmatter + description
├── scripts/
│   ├── main.py           # Reference implementation
│   ├── helper.py         # Supporting modules
│   └── ...
├── requirements.txt      # Python dependencies (if Python)
├── package.json          # Node dependencies (if TypeScript)
└── config/               # Optional: config templates
    └── default.yaml
```

## SKILL.md Frontmatter

The SKILL.md file is the heart of a SKILL package. It uses YAML frontmatter followed by markdown content.

### Complete Frontmatter Reference

```yaml
---
# Required
name: my-skill                     # Unique identifier (kebab-case)
description: |                     # Multi-line description
  What this SKILL does, in detail.
  Claude Code reads this to understand what to generate.
version: 1.0.0                    # SemVer

# Tentacle spawning config
spawnable: true                    # Can be spawned as a tentacle
runtime: python                    # python | typescript | go | shell
entry: scripts/main.py            # Entry point relative to SKILL dir
default_trigger: "every 30 minutes"  # Default schedule

# Setup commands (run during deployment)
setup_commands:
  - "python3 -m venv venv"
  - "venv/bin/pip install -r requirements.txt"

# Requirements
requires:
  bins: [python3]                  # Required system binaries
  env: [GITHUB_TOKEN, OPENROUTER_API_KEY]  # Required env vars

# Discovery
trigger_keywords: [GitHub, 仓库, Issue, PR]  # Match user intent
emoji: "🐙"                       # Display emoji

# Optional metadata
author: your-name
license: MIT
tags: [monitoring, github, automation]
---
```

### Markdown Body

After the frontmatter, describe the SKILL in markdown. This is what Claude Code reads as context:

```markdown
# My Skill Name

## 使命 (Mission)
One-paragraph description of what this tentacle does.

## 工作流 (Workflow)
Step-by-step description of the tentacle's main loop:
1. Step one...
2. Step two...
3. ...

## 上报策略 (Report Strategy)
When and how the tentacle reports to the Brain:
- Urgent items: immediately
- Normal items: batch when 3+ accumulated
- Daily summary: at least once per day

## 基础设施 (Infrastructure)
What the tentacle needs:
- Local SQLite database
- LLM calls via OpenRouter
- External API client
```

## IPC Contract Requirements

Every tentacle generated from a SKILL must implement the OpenCeph IPC contract:

1. **Connect** to the Unix socket at `OPENCEPH_SOCKET_PATH`
2. **Register** by sending `tentacle_register` message on startup
3. **Report** via `consultation_request` (batch mode preferred)
4. **Handle directives**: at minimum `kill`, `pause`, `resume`, `trigger`
5. **Support** `OPENCEPH_TRIGGER_MODE` env var (`self-schedule` or `external`)

The reference scripts in your SKILL should demonstrate these patterns. Claude Code will use them as inspiration, not copy them verbatim.

## Reference Code Guidelines

Your `scripts/` directory should contain working reference code that demonstrates:

- IPC connection and registration
- Main work loop with proper trigger mode handling
- Batch consultation reporting
- Directive handling (kill/pause/resume/trigger)
- Signal handling for clean shutdown
- Error handling and logging

Keep reference code clean and well-commented. Claude Code reads it to understand patterns, then generates customized code for the user's specific needs.

## Creating a SKILL from Scratch

### Step 1: Create the directory

```bash
mkdir -p ~/.openceph/skills/my-monitor/scripts
```

### Step 2: Write SKILL.md

```yaml
---
name: my-monitor
description: |
  Monitors a specific data source and reports findings to the Brain.
version: 1.0.0
spawnable: true
runtime: python
entry: scripts/main.py
default_trigger: "every 1 hour"
setup_commands:
  - "python3 -m venv venv"
  - "venv/bin/pip install -r requirements.txt"
requires:
  bins: [python3]
  env: [OPENROUTER_API_KEY]
trigger_keywords: [monitor, watch, track]
emoji: "👁️"
---

# My Monitor

## 使命
Monitor [data source] for changes and report significant findings.

## 工作流
1. Poll data source every hour
2. Compare with previous state (stored in local SQLite)
3. Use LLM to assess significance of changes
4. Accumulate significant findings
5. When 3+ findings accumulated, batch report to Brain

## 上报策略
- Critical changes: immediate single report
- Normal findings: batch when 3+ accumulated
- Daily summary even if no findings (heartbeat)

## 基础设施
- SQLite for state tracking
- LLM for significance assessment
- HTTP client for data source API
```

### Step 3: Write reference scripts

Create `scripts/main.py` with the IPC connection pattern (see existing SKILLs for examples).

### Step 4: Add requirements

```
# requirements.txt
requests>=2.31.0
```

### Step 5: Test

```bash
# Ask Ceph to spawn from your SKILL
openceph chat
> Help me monitor [something]
# Ceph should match your SKILL and offer to create a tentacle
```

## Publishing

### GitHub

Push your SKILL directory to a GitHub repo. Users can install by cloning:

```bash
git clone https://github.com/you/openceph-skill-my-monitor ~/.openceph/skills/my-monitor
```

### npm (as part of a collection)

```json
{
  "name": "@openceph-skills/my-monitor",
  "version": "1.0.0",
  "keywords": ["openceph-skill"],
  "openceph": {
    "skillName": "my-monitor"
  }
}
```

Install:

```bash
npm install @openceph-skills/my-monitor
# Then copy to skills dir or configure skills.paths
```

## Security Considerations

- **Never hardcode API keys** in reference scripts. Use `os.environ` / `process.env`.
- **Avoid dangerous patterns** that the validator will reject:
  - Python: `os.system()`, `subprocess.Popen()`, `exec()`, `eval()`, `__import__()`
  - TypeScript: `child_process.exec()`, `eval()`, `Function()`
  - Shell: `curl | bash`, `rm -rf /`
- **Use the credential store**: reference `OPENCEPH_*` env vars which are populated by the deployer from `~/.openceph/credentials/`
- Generated tentacles go through a 4-stage validation pipeline (syntax, contract, security, smoke test) before deployment.

## Example SKILLs

See the built-in SKILLs for complete examples:

- `github-project-assistant` — GitHub repo monitoring with LLM classification
- `content-creator-assistant` — Content collection, analysis, and publishing with Feishu bot
- `producthunt-monitor` — Product Hunt new product monitoring
- `web-researcher` — Web research and summarization
