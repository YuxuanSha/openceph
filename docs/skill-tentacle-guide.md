# skill_tentacle Development Guide

## Overview

skill_tentacle is the standardized tentacle packaging format for OpenCeph. Community developers package once, and all users can deploy directly.

## Directory Structure

```
{tentacle-name}/
├── SKILL.md                # Required: Pi-compatible frontmatter + tentacle description
├── README.md               # Required: Deployment guide (read and executed by Claude Code)
├── prompt/
│   ├── SYSTEM.md           # Required: Tentacle system prompt
│   ├── AGENTS.md           # Optional: Behavior rules
│   └── TOOLS.md            # Optional: Tool descriptions
├── src/
│   ├── main.py             # Required: Main process entry point
│   ├── ipc_client.py       # Recommended: Standard IPC client
│   ├── ...                 # Other business code
│   └── requirements.txt    # Required: Dependency list
└── docs/                   # Optional: Reference documentation
```

## SKILL.md Frontmatter Specification

```yaml
---
name: my-tentacle
description: One-line description of tentacle functionality
version: 1.0.0
trigger_keywords:
  - keyword1
  - keyword2
metadata:
  openceph:
    emoji: 🔍
    trigger_keywords:
      - trigger word 1
      - trigger word 2
    tentacle:
      spawnable: true                    # Required: Mark as deployable
      runtime: python                    # python | typescript | go | shell
      entry: src/main.py                 # Entry file
      default_trigger: self              # self | external
      setup_commands:                    # Commands run during deployment
        - pip install -r src/requirements.txt
      requires:
        bins:                            # Required system binaries
          - python3
        env:                             # Required environment variables
          - MY_API_KEY
      capabilities:                      # Tentacle capability tags
        - web_fetch
        - data_filter
      infrastructure:                    # Infrastructure requirements
        needsLlm: false
        needsDatabase: false
        needsHttpServer: false
        needsExternalBot: false
      customizable:                      # Customizable fields
        - field: my_setting
          description: Setting description
          env_var: MY_SETTING            # Injected into .env
          default: "default_value"
          example: "example_value"
        - field: user_name
          description: User name
          prompt_placeholder: "{USER_NAME}"  # Replaces placeholder in SYSTEM.md
          default: "User"
---

# my-tentacle

Detailed description...
```

### Key Field Descriptions

| Field | Required | Description |
|-------|----------|-------------|
| `spawnable: true` | Yes | Marks as a deployable skill_tentacle |
| `runtime` | Yes | Runtime: python / typescript / go / shell |
| `entry` | Yes | Entry file path |
| `default_trigger` | Yes | Default trigger mode: self (self-managed loop) / external (wait for external trigger) |
| `setup_commands` | Yes | Initialization commands run during deployment |
| `requires.bins` | No | System binaries that must be pre-installed |
| `requires.env` | No | Environment variables the user must provide |
| `customizable` | No | User-customizable configuration fields |

### Customizable Field Types

1. **env_var injection**: Value written to `.env` file
   ```yaml
   - field: api_key
     description: API key
     env_var: MY_API_KEY
   ```

2. **prompt_placeholder injection**: Replaces `{PLACEHOLDER}` in SYSTEM.md
   ```yaml
   - field: user_name
     prompt_placeholder: "{USER_NAME}"
     default: "User"
   ```

## README.md Writing Guidelines

README.md is the guide Claude Code uses during deployment and must include:

1. **Overview** (one sentence)
2. **Environment requirements** (Python/Node version)
3. **Environment variables table**
4. **Deployment steps** (exact bash commands)
5. **Start command**
6. **FAQ**
7. **Personalization guide**

Example:

```markdown
# GitHub Issue Radar

Monitor new issues and PRs in specified GitHub repositories.

## Environment Requirements
- Python 3.10+

## Environment Variables
| Variable | Required | Description |
|----------|----------|-------------|
| GITHUB_TOKEN | Yes | GitHub Personal Access Token |
| GITHUB_REPOS | Yes | List of repositories to monitor (comma-separated) |

## Deployment Steps
```bash
cd {TENTACLE_DIR}
python3 -m venv venv
source venv/bin/activate
pip install -r src/requirements.txt
```

## Start Command
```bash
python3 src/main.py
```
```

## prompt/SYSTEM.md Writing Guidelines

```markdown
# Identity
You are the GitHub Issue Radar tentacle.

# Mission
Monitor issues and PRs in specified repositories, filtering for technical topics that {USER_NAME} cares about.

# User Context
- User name: {USER_NAME}
- Technical interests: {USER_TECHNICAL_FOCUS}

# Judgment Criteria
- Important: Issues directly related to the user's areas of interest
- Normal: Technical discussions, feature requests
- Ignore: Bot-generated, duplicates

# Report Strategy
- Batch report once per cycle
- Mark important findings immediately
- Discard noise directly

# Report Format
Title: [repo name] issue title
Link: URL
Summary: One-sentence overview
Judgment: important / reference / discard

# Constraints
- Do not generate code
- Do not modify any files
- API calls must respect rate limits
```

## IPC Three Contracts

All skill_tentacles must implement:

### Contract 1: Startup Registration

Send immediately after connecting to `OPENCEPH_SOCKET_PATH`:

```json
{
  "type": "tentacle_register",
  "sender": "<tentacle_id>",
  "receiver": "brain",
  "payload": {
    "tentacle_id": "<tentacle_id>",
    "purpose": "Tentacle mission",
    "runtime": "python",
    "pid": 12345
  },
  "timestamp": "2024-01-01T00:00:00.000Z",
  "message_id": "uuid"
}
```

### Contract 2: Batch Reporting

Report findings via `consultation_request`:

```json
{
  "type": "consultation_request",
  "sender": "<tentacle_id>",
  "receiver": "brain",
  "payload": {
    "tentacle_id": "<tentacle_id>",
    "request_id": "uuid",
    "mode": "batch",
    "items": [
      {
        "id": "item-1",
        "content": "Finding content",
        "reason": "Filtering rationale",
        "tentacleJudgment": "important"
      }
    ],
    "summary": "Scan summary for this cycle"
  },
  "timestamp": "2024-01-01T00:00:00.000Z",
  "message_id": "uuid"
}
```

### Contract 3: Receiving Directives

Handle `directive` messages from the Brain:

```json
{
  "type": "directive",
  "sender": "brain",
  "receiver": "<tentacle_id>",
  "payload": {
    "action": "pause"  // pause | resume | kill | run_now
  }
}
```

## Trigger Modes

Read the `OPENCEPH_TRIGGER_MODE` environment variable:

- **self**: Internal timed loop (reads CHECK_INTERVAL and other config)
- **external**: Wait for `run_now` directive to trigger

```python
trigger_mode = os.environ.get("OPENCEPH_TRIGGER_MODE", "self")
if trigger_mode == "self":
    while running:
        do_scan()
        time.sleep(interval_seconds)
else:
    # Wait for run_now directive
    while running:
        time.sleep(1)
```

## Python IPC Client

It is recommended to reuse the standard IPC client provided by OpenCeph:

```python
from ipc_client import IpcClient

client = IpcClient(socket_path, tentacle_id)
client.connect()
client.register(purpose="Monitor GitHub Issues", runtime="python")

# Report
client.consultation_request(
    mode="batch",
    items=[{"id": "1", "content": "...", "tentacleJudgment": "important"}],
    summary="Found 3 important issues"
)

# Handle directives
def handle_directive(payload):
    action = payload.get("action")
    if action == "kill":
        sys.exit(0)

client.on_directive(handle_directive)
```

## --dry-run Support (Recommended)

Implement the `--dry-run` parameter to verify configuration and API connectivity without starting the main loop:

```python
if "--dry-run" in sys.argv:
    print("Config OK")
    print(f"Repos: {repos}")
    print(f"API connection: OK")
    sys.exit(0)
```

## Packaging and Distribution

### Packaging a Deployed Tentacle

```bash
openceph tentacle pack <tentacle_id>
# Output: ~/.openceph/packages/<tentacle_id>.tentacle
```

### Installing a skill_tentacle

```bash
# From a .tentacle file
openceph tentacle install ./my-tentacle.tentacle

# From GitHub
openceph tentacle install github:user/repo/skills/my-tentacle

# From a local directory
openceph tentacle install ./path/to/skill-tentacle/
```

### List Installed

```bash
openceph tentacle list
```

### View Details

```bash
openceph tentacle info my-tentacle
```

### Validate

```bash
openceph tentacle validate ./path/to/skill-tentacle/
```

## Validation Rules

skill_tentacles go through 4 validation checks before deployment:

1. **Structure**: Directory structure completeness (SKILL.md, README.md, prompt/SYSTEM.md, src/)
2. **Syntax**: Code syntax correctness (Python: py_compile, TS: tsc --noEmit)
3. **Contract**: IPC three-contract compliance (tentacle_register, consultation_request, directive handling)
4. **Security**: Security blocklist check (prohibits exec/eval/os.system, etc.)

## Example skill_tentacles

OpenCeph includes 3 built-in examples:

1. **github-issue-radar** — Monitor GitHub repo issues/PRs (Scene 1 reference implementation)
2. **hn-engineering-digest** — HN engineering hot posts digest (Scene 2 artifact)
3. **content-creator-assistant** — Content creation assistant (complex Agent system)

View source code: `~/.openceph/skills/` or project `src/templates/skills/`

## Development Workflow

1. Create the directory structure
2. Write SKILL.md (frontmatter must include `spawnable: true`)
3. Write README.md (Claude Code deployment guide)
4. Write prompt/SYSTEM.md (with `{PLACEHOLDER}` placeholders)
5. Implement src/main.py (IPC three contracts + trigger mode)
6. Validate: `openceph tentacle validate ./my-tentacle/`
7. Test: `python3 src/main.py --dry-run`
8. Package: `openceph tentacle pack <id>` or share the directory directly
