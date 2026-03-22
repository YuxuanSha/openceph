# skill_tentacle Package Specification

A skill_tentacle is a standardized tentacle packaging format. Community developers package once, all users deploy directly.

## Directory Structure

```
{tentacle-name}/
├── SKILL.md                # Required: Pi-compatible frontmatter + tentacle description
├── README.md               # Required: Deployment guide for Claude Code
├── prompt/
│   ├── SYSTEM.md           # Required: Tentacle's system prompt
│   ├── AGENTS.md           # Optional: Behavioral rules
│   └── TOOLS.md            # Optional: Tool descriptions
├── src/
│   ├── main.py             # Required: Main process entry
│   ├── ipc_client.py       # Recommended: Standard IPC client
│   ├── ...                 # Other business code
│   └── requirements.txt    # Required: Dependencies
└── docs/                   # Optional: Reference documentation
```

## SKILL.md Frontmatter

Must include `metadata.openceph.tentacle.spawnable: true` and standard fields:
- name, description, version
- metadata.openceph.emoji, trigger_keywords
- metadata.openceph.tentacle: runtime, entry, default_trigger, setup_commands, requires, capabilities, infrastructure, customizable

## README.md Requirements

Must be self-explanatory for Claude Code deployment:
1. Overview (one sentence)
2. Environment Requirements (Python/Node version)
3. Environment Variables table
4. Deployment Steps (exact bash commands)
5. Start Command
6. Common Issues & Fixes
7. Personalization Guide

## prompt/SYSTEM.md Structure

1. Identity (one line)
2. Mission (2-3 sentences)
3. User Context (with {PLACEHOLDER} variables)
4. Judgment Criteria (detailed)
5. Report Strategy (immediate/batch/discard rules)
6. Report Format (template)
7. Constraints

## IPC Three Contracts (src/ must implement)

1. **Register**: Connect to OPENCEPH_SOCKET_PATH → send `tentacle_register`
2. **Report**: Batch findings via `consultation_request` (mode: batch/single/action_confirm)
3. **Directives**: Handle `directive` messages (pause/resume/kill/run_now)

## Trigger Mode Support

Read `OPENCEPH_TRIGGER_MODE` environment variable:
- `self`: Internal timer loop
- `external`: Wait for `run_now` directive

## --dry-run Support (Recommended)

Validate config and API connectivity without starting main loop.
