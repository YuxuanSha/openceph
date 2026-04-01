# TOOLS.md — Tool Usage Guide

## Memory Tools
read_memory — Read a specific section or the full text of MEMORY.md
write_memory — Write a memory entry to the daily log memory/YYYY-MM-DD.md
update_memory — Update an existing memory entry
delete_memory — Delete a specific memory entry
memory_get — Read a specific memory file
memory_search — Search MEMORY.md and memory/ logs for relevant memories
distill_memory — Distill daily logs into MEMORY.md

## Messaging Tools
send_to_user — Send a proactive message to the user. The only permitted channel for reaching the user in the system.

## Session Tools
sessions_list — List recently active sessions
sessions_history — View recent message history for a specific session

## Heartbeat Tools
create_heartbeat_task — Add a pending task to HEARTBEAT.md
complete_heartbeat_task — Mark a task in HEARTBEAT.md as complete

## Skill Tools
read_skill — Read a SKILL definition file
skills_list — List currently available SKILLs

## Tentacle Management Tools

### spawn_from_skill — Deploy a tentacle
When to use: When the user requests deploying a new tentacle.
mode selection: See "How to determine which mode to use" in AGENTS.md.
config: Keys correspond to the env_var of customizable fields in SKILL.md. If unsure, use read_skill to check.
brief: Only needed for scenarios B/C; not needed for scenario A.

### list_tentacles — View tentacle list
When to use: When you want to know what tentacles exist and their status.
status_filter valid values: all, active, running, registered, deploying, pending, paused, weakened, killed, crashed
Non-existent values: offline, stopped, dead, error — do not use these.
If unsure which value to use, use all to get the full list and judge for yourself.

### manage_tentacle — Manage a tentacle
When to use: When pausing, resuming, stopping, or immediately running a tentacle.

Prerequisites for each action:
  pause → tentacle must be in running state
  resume → tentacle must be in paused state
  kill → tentacle is in running or paused state
  run_now → tentacle must be in running state (triggers one immediate execution)
  strengthen → tentacle is in running state (upgrades capabilities, will invoke Claude Code)
  weaken → tentacle is in running state (reduces trigger frequency)

Common mistakes:
  ✗ Calling resume on a killed tentacle → not possible; killed tentacles must be re-spawned via spawn_from_skill
  ✗ Using strengthen to fix a broken tentacle → wrong; strengthen is for upgrading functionality
  ✗ Calling resume directly on a crashed tentacle → should first inspect_tentacle_log to find the cause

### inspect_tentacle_log — View tentacle logs
When to use: When a tentacle deployment fails, runs abnormally, or you want to understand what a tentacle is doing.
This is the first-choice tool for troubleshooting tentacle issues. Reading logs is far more useful than guessing.

### read_skill — Read SKILL information
When to use: Before deployment to confirm a SKILL exists, view customizable fields, or understand tentacle capabilities.
Always read_skill before each deployment — don't rely on memory.

### manage_tentacle_schedule — Manage a tentacle's cron, heartbeat, and self-managed frequency

Valid action values:
  set_tentacle_cron — Create a cron-triggered schedule (requires cron_config.expr)
  remove_tentacle_cron — Delete a cron job (requires cron_job_id)
  set_tentacle_heartbeat — Enable heartbeat (requires heartbeat_config.every)
  disable_tentacle_heartbeat — Disable heartbeat
  set_self_schedule — Set self-managed scheduling interval (requires self_schedule_config.interval, e.g., "1m", "30m", "2h")
  get_schedule — View current scheduling configuration

Common mistakes:
  ✗ set_self_schedule_interval → correct name is set_self_schedule
  ✗ Calling set_self_schedule without passing self_schedule_config.interval → will error

Note: After executing an action, check the return result to confirm success. Do not assume it always succeeds.

### review_tentacles — Review all active tentacles, returning weaken/kill/merge/strengthen recommendations based on health scores

## Search Tools

### web_search — Web search
When to use:
  - The user asks you to search a topic ("search for xxx")
  - A tentacle's work requires external data (news, papers, product info)
  - You're not sure of the answer to the user's question

When absolutely not to use:
  - OpenCeph internal system issues (deployment failures, tentacle crashes, IPC errors, configuration problems)
  - The internet has no useful information about these issues
  - For internal issues, use inspect_tentacle_log or read tool_result error messages directly

### web_fetch — Fetch a webpage
When to use: When you need to read the content of a specific URL.
Do not use this to fetch OpenCeph internal files (use the read tool).

## File Tools

### read — Read a local file
Used to read any file on the local filesystem. Including:
  - Files in your own workspace
  - Files in tentacle directories (e.g., ~/.openceph/tentacles/t_xxx/src/requirements.txt)
  - Files in tentacle workspaces (e.g., ~/.openceph/tentacles/t_xxx/workspace/STATUS.md)
  - Spec documents (~/.openceph/contracts/skill-tentacle-spec/SPEC.md)

Do not use memory_get to read tentacle files — memory_get only reads memory files under the memory/ directory.
Do not use web_fetch to read local files — web_fetch can only fetch HTTP URLs.

### write / edit — Write/edit files
Only write files within your own workspace. Do not write files in tentacle directories (those are managed by the tentacles themselves).

## Code Tools
invoke_code_agent — Generate and write new tentacle code (complete Agent system) to disk; does not automatically claim it is running. Only when spawned=true does it indicate the tentacle has been started.

## Cron
cron_add — Create a scheduled task
cron_list — List all scheduled tasks
cron_update — Modify a scheduled task
cron_remove — Delete a scheduled task
cron_run — Manually trigger a scheduled task

## Tool Usage Principles
- Don't call tools when you can answer directly
- For normal replies in the current conversation turn, output text directly; do not call send_to_user
- send_to_user is only for proactive notifications, async reminders, and outbound messages outside the current session
- When the user says "search for," "look up," "find," "news," or similar requests needing real-time information, you must call web_search
- If you haven't actually called web_search, never claim "I already searched"
- Summarize search results directly in your reply; no need to call send_to_user again
- web_fetch does not execute JS; be aware with JS-heavy pages
- After calling invoke_code_agent / spawn_from_skill, you must accurately distinguish between generated, deployed, spawned, and running based on the tool result — do not say "deployed" means "running"
- Only say "started/running in background" when tool result explicitly shows spawned=true or evidence of running state
- Only reference real log paths returned by tool result or the status system — never fabricate logs/ directory paths
