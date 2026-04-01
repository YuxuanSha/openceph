# OpenCeph Codebase Complete Guide

## Overview

OpenCeph is a Pi-framework-based AI Personal Operating System. It allows users to converse with the "Brain" through multiple channels (Telegram, Feishu, WebChat, CLI). The Brain has personality, memory, search capability, and a complete Workspace file system.

**Core Features:**
- Multi-channel integration (Telegram, Feishu, WebChat, CLI)
- Pi-framework-based Brain Agent with streaming responses
- Memory system (long-term MEMORY.md + short-term conversation history)
- Tool system (Brain can call tools to interact with the outside world)
- MCP support (connect MCP servers to extend tool capabilities)
- Tentacle system — Brain's proactive execution capability
- Scheduled tasks (Cron) and heartbeat push (Heartbeat)
- Active push pipeline (consultation → `send_to_user` → main session / IM delivery)
- Built-in skill_tentacle auto-install and upgrade

---

## Project Structure

```
openceph/
├── builtin-tentacles/        # Built-in skill_tentacles (7)
├── src/                      # Source code
│   ├── main.ts               # Full startup flow (Gateway + Brain + all services)
│   ├── cli.ts                # CLI entry point, all command-line tools
│   ├── config/               # Configuration system
│   ├── pi/                   # Pi framework wrapper
│   ├── brain/                # Brain core
│   ├── gateway/              # Gateway (message routing)
│   ├── tools/                # Tool system
│   ├── mcp/                  # MCP bridge
│   ├── memory/               # Memory system
│   ├── tentacle/            # Tentacle system
│   ├── cron/                 # Scheduled task system
│   ├── heartbeat/            # Heartbeat push system
│   ├── push/                 # Push decision system
│   ├── skills/               # Skill system
│   ├── code-agent/           # Code execution agent
│   ├── logger/               # Logging system
│   ├── session/              # Session storage
│   └── templates/            # Template files
├── dist/                     # Build output
├── tests/                    # Tests
├── docs/                     # Documentation
└── package.json
```

---

## Module Details

### 1. Entry Points

#### [main.ts](src/main.ts)
Full startup flow, coordinates all components:
1. Set global proxy (proxy-setup.ts)
2. Load configuration (config-loader.ts)
3. Initialize logging system
4. Create Pi Context
5. Initialize MCP Bridge
6. Create and initialize Brain
7. Register MCP tools with Brain
8. Create and start Gateway
9. Register channel adapters (Telegram, Feishu, WebChat, CLI)
10. Start Cron scheduler
11. Start Heartbeat scheduler
12. Start Session reset scheduler
13. Register graceful shutdown handler

#### [cli.ts](src/cli.ts)
CLI entry point, implemented using Commander.js:

**Subcommands:**
| Command | Description |
|---------|-------------|
| `init` | Initialize OpenCeph (creates ~/.openceph/ directory structure) |
| `upgrade` | Sync builtin tentacles to `~/.openceph/skills/` |
| `start` | Start full service (Gateway + Brain + all channels) |
| `chat` | CLI chat mode (no Gateway) |
| `pairing list/approve/reject/revoke` | Pairing management |
| `credentials set/get/list/delete` | Credential management |
| `cron list/add/edit/remove/run/runs` | Cron task management |
| `logs [type]` | View logs |
| `status` | Show system status |
| `cost` | Show cost summary |
| `doctor` | System health check |
| `plugin list/install/uninstall` | Plugin management |

---

### 2. Configuration System (`src/config/`)

#### [config-loader.ts](src/config/config-loader.ts)
- Loads configuration from `~/.openceph/openceph.json` (supports JSON5 syntax)
- Resolves credential references (`from:credentials/xxx`, `env:VAR`, `keychain:service:key`)
- Validates configuration using Zod
- Expands `~` in paths

#### [config-schema.ts](src/config/config-schema.ts)
- Defines complete configuration schema (using Zod)
- Includes: gateway, channels, agents, models, auth, mcp, session, cron, heartbeat, push, tentacle, skills, logging, cost, etc.

Supplementary notes:
- `tentacle.model` / `tentacle.models` / `tentacle.providers` / `tentacle.auth` form the tentacle independent runtime configuration
- Tentacle model resolution logic is in `src/config/model-runtime.ts`
- Business code is developed in the repository, but runtime configuration still comes from `~/.openceph/openceph.json`

#### Configuration Migration Notes (2026-03 Hotfix)

When a user has run too many old versions, has stale models in `~/.openceph/agents/**/sessions.json`, or `state/` is inconsistent with current source behavior, the recommended ops action is NOT to directly modify the old directory, but:

1. Stop the current `start` process
2. Fully back up `~/.openceph/`
3. Re-run `openceph init`
4. Restore key credentials (OpenRouter / Feishu, etc.) with `credentials set`
5. Only edit the newly generated `~/.openceph/openceph.json`

This procedure should be in all ops/troubleshooting SOPs because it avoids cross-contamination from old `sessions/`, old `state/`, old templates, and old tentacle deployment directories.

#### [credential-store.ts](src/config/credential-store.ts)
- Credential storage and management
- Supports reading credentials from file, environment variables, macOS Keychain

#### [proxy-setup.ts](src/config/proxy-setup.ts)
- Set global HTTP/HTTPS proxy
- Supports reading proxy config from `HTTP_PROXY`/`HTTPS_PROXY` environment variables

---

### 3. Pi Framework Wrapper (`src/pi/`)

Based on `@mariozechner/pi-agent-core`.

#### [pi-context.ts](src/pi/pi-context.ts)
- Create and manage Pi Context
- Initialize core Pi framework components
- Register Pi Extensions: `memory-injector`, `context-pruner`, `push-message-merger`, `compaction-guard`

#### [pi-session.ts](src/pi/pi-session.ts)
- Create Brain Session
- Manage conversation session state

#### [pi-models.ts](src/pi/pi-models.ts)
- Define supported model list
- Includes Anthropic and OpenAI model definitions

#### [pi-auth.ts](src/pi/pi-auth.ts)
- Authentication configuration management
- Supports API Key authentication

#### [model-resolver.ts](src/pi/model-resolver.ts)
- Model resolution and selection
- Handle model availability checks

---

### 4. Brain Core (`src/brain/`)

This is the core of the system, handling AI conversation logic.

#### [brain.ts](src/brain/brain.ts) — **Core File**
Full Brain class implementation, main capabilities:

- **Message handling** (`handleMessage`): Process user messages, execute conversation turns
- **Tool registration**: Register various tools (memory, user, session, heartbeat, skill, web, tentacle, code, cron, mcp)
- **System prompt construction**: Dynamically assemble system prompts
- **Session management**: Create, reset sessions
- **Model switching**: Support model failover
- **Context compaction**: Support context compression to reduce token usage
- **Heartbeat handling** (`runHeartbeatTurn`): Handle scheduled heartbeat
- **Tentacle integration**: Interact with the tentacle system
- **Push decision**: Evaluate whether to push content to user
- **Deferred delivery**: Handle `best_time` / `morning_digest` queues
- **Cross-session dual-write**: Write consultation-sourced pushes to main session at actual delivery time
- **Daily/Weekly review**: Auto-run review tasks

#### Model Selection Hotfix (2026-03)

After this round of fixes, Brain's model selection logic has two important changes:

- `handleMessage()` no longer directly trusts a global `currentModel` as the default for all sessions; instead it first resolves the currently selected model for that `sessionKey`
- When `sessionKey` or model changes, it discards the old Pi session in memory and rebuilds the session with the new transcript / model

The reason: the old implementation made "current model" a process-level global state, causing session A's `/model` switch to affect session B as well; at the same time, the `model` metadata in `sessions.json` could diverge from the actual model used in the session.

Current implementation constraints:

- `agents.defaults.model.primary` in `~/.openceph/openceph.json` is the default model source
- `/model` only affects the current session
- `SessionStoreManager.updateModel()` writes the current session's selected model back to `~/.openceph/agents/<agent>/sessions/sessions.json`
- Brain's auto failover no longer silently switches a session from one model to another; explicit `/model` is required by default

**Key Methods:**
```typescript
class Brain {
  async handleMessage(input: BrainInput): Promise<BrainOutput>
  async initialize(): Promise<void>
  async registerTools(entries: ToolRegistryEntry[]): Promise<void>
  async resetSession(newModel?: string, sessionKey?: string): Promise<void>
  async compactSession(customInstructions?: string): Promise<string>
  async runHeartbeatTurn(text: string): Promise<BrainOutput>
  async runIsolatedTurn(params: {...}): Promise<BrainOutput>
  async evaluatePush(trigger: PushTrigger): Promise<string | null>
  async runDailyReviewAutomation(): Promise<string>
  // ... more methods
}
```

#### [system-prompt.ts](src/brain/system-prompt.ts)
- Assemble system prompts
- Read prompt content from Workspace files (SOUL.md, AGENTS.md, etc.)

#### [context-assembler.ts](src/brain/context-assembler.ts)
- Context assembler
- Check if Workspace is new

#### [extensions/](src/brain/extensions/)
- `memory-injector.ts`: Memory injection extension
- `context-pruner.ts`: Context pruning extension
- `push-message-merger.ts`: Runtime merging of consecutive assistant messages
- `compaction-guard.ts`: Compaction protection extension

#### Active Push Pipeline Supplement

After Phase 7, the tentacle push pipeline is no longer just "call Gateway to send a message", but goes through the complete flow:

1. Tentacle reports to Brain via `consultation_request`
2. Brain decides whether to call `send_to_user` in consultation / cron session
3. `send_to_user` performs cross-session dual-write under consultation source
4. Message is written to main session transcript, metadata tagged as `tentacle_push`
5. Gateway delivers immediately, or enters `best_time` / `morning_digest` queue
6. Before API call, `push-message-merger` merges consecutive assistant messages to avoid context format conflicts

This means when "user replies to tentacle push", the Brain can naturally see that historical push in the main session.

### 4.1 Tentacle Deployment Pipeline Hotfix (Phase 8)

This round of fixes focused not on new product capabilities, but on connecting the previously broken tentacle pipeline:

- IPC protocol unified to `stdin/stdout JSON Lines`
  Runtime spawns tentacles in `src/tentacle/manager.ts` with `stdio: ["pipe","pipe","pipe"]`
  `src/tentacle/ipc-server.ts` now prioritizes parsing child process stdout, and delivers directives via stdin
- `.env` / credentials parsing fixes
  `src/skills/skill-spawner.ts` no longer incorrectly maps `OPENROUTER_API_KEY` to wrong paths
  Missing required credentials directly blocks startup and returns friendly errors
- Code deployment path fixes
  `src/code-agent/deployer.ts` now clears the old directory before deployment (preserving `.env` / `data` / logs)
  After deployment, validates that the entry file actually exists to avoid workdir/runtime dir divergence

These three points were the direct root cause of HN / arXiv demands repeatedly falling back to cron in logs.

### 4.2 Runtime Status and Logging Hotfix (2026-03)

This round added two more infrastructure constraints:

- **Hard separation of status semantics**
  `generated`, `deployed`, `spawned`, `registered/running` must be treated as distinct phases
  `src/brain/system-prompt.ts`, `src/brain/brain.ts`, and workspace `AGENTS.md` all added rules "forbid saying deployed when it means running"
- **Log directory restructuring**
  Ceph / Gateway / code-agent migrated to `~/.openceph/agents/<agent>/logs/`
  Tentacles migrated to `~/.openceph/tentacles/<tentacle_id>/logs/`
  code-agent single runs now additionally generate `runs/<session>/stdout.log`, `stderr.log`, `terminal.log`

The goal of this fix was not to replace the logging framework, but to thoroughly close "whose logs go where", making it easy to locate incubation/runtime issues like HN.

#### [loop-detection.ts](src/brain/loop-detection.ts)
- Detect tool call loops
- Prevent infinite loops

#### [failover.ts](src/brain/failover.ts)
- Model failover logic
- Context limit checks

---

### 5. Gateway System (`src/gateway/`)

Responsible for message routing and channel integration.

#### [gateway.ts](src/gateway/gateway.ts) — **Core File**
- Manage all channel adapters in the system
- Coordinate message routing
- Manage plugin hot-loading

**Key functions:**
- `registerChannel()`: Register channel plugin
- `deliverToUser()`: Send message to user
- `start()`/`stop()`: Start/stop gateway

Supplementary notes (2026-03):

- `gateway_start` only indicates channel plugin initialization succeeded, not that every channel necessarily exposes the same port
- WebChat actual listening port is based on `webchat.port` in `channel_start` log
- If ops scripts only check `runtime-status.json.gateway.port`, they may misjudge the actual connectable WebChat port; troubleshooting should also look at `gateway-*.log`

#### [router.ts](src/gateway/router.ts)
- Message router
- Decides how messages are processed

#### [session-manager.ts](src/gateway/session-manager.ts)
- Session parsing and resolvers
- Manage session keys

#### [session-store.ts](src/session/session-store.ts)
- Persist `sessions.json`
- Save session transcript paths, token stats, origin, and the currently selected model for the session

After 2026-03, the `model` field here should be understood as:

- Not "system-wide current model"
- Not "snapshot of last message_complete provider/model in Pi transcript"
- But rather "the selected model this session should continue using in the next turn"

This is also the fundamental reason for "don't directly edit old sessions.json, prefer rebuilding `~/.openceph/`" in README — the `model` field left by old versions may not be reliable.

#### [message-queue.ts](src/gateway/message-queue.ts)
- Message queue management
- Message buffering and rate limiting

#### [pairing.ts](src/gateway/pairing.ts)
- Pairing system management
- New user approval flow

#### [session-reset.ts](src/gateway/session-reset.ts)
- Session auto-reset scheduler
- Supports daily reset and idle reset

#### [plugin-loader.ts](src/gateway/plugin-loader.ts)
- Dynamically load extension channel plugins
- Supports hot-loading

---

### 6. Channel Adapters (`src/gateway/adapters/`)

#### [telegram/](src/gateway/adapters/telegram/)
- Telegram Bot integration
- Uses `grammy` framework
- Message formatter

#### [feishu/](src/gateway/adapters/feishu/)
- Feishu message card integration
- Uses `@larksuiteoapi/node-sdk`
- Message formatter

#### [webchat/](src/gateway/adapters/webchat/)
- WebSocket Web Chat service
- Implemented with Express + ws

#### [cli/](src/gateway/adapters/cli/)
- Local CLI chat adapter
- Implemented with readline

---

## Tentacle Development Notes

### 1. Runtime Protocol

- New tentacles use `stdin/stdout JSON Lines`
- `stdout` can only output IPC messages; business logs must write to `stderr`
- `OPENCEPH_TENTACLE_ID` and `OPENCEPH_TRIGGER_MODE` are injected by the runtime
- Do NOT depend on `OPENCEPH_SOCKET_PATH` / `OPENCEPH_IPC_SOCKET` in new code

### 2. Configuration Source

- Do not hardcode runtime secrets into the repository
- Tentacle dependencies (provider / auth / model) are controlled by `tentacle.*` configuration in `~/.openceph/openceph.json`
- skill_tentacle custom fields and required env vars are injected to the deployment directory `.env` by `SkillSpawner.injectUserConfig()`

### 3. Built-in Tentacles

Tentacles under `builtin-tentacles/` can serve as Phase 7 reference implementations:

- `hn-radar`
- `arxiv-paper-scout`
- `github-release-watcher`
- `daily-digest-curator`
- `price-alert-monitor`
- `uptime-watchdog`
- `skill-tentacle-creator`

Among these, HN / arXiv two builtins are now complete:

- `stdin/stdout` IPC client
- `pause` / `resume` / `kill` / `run_now` directive handling
- Full consultation → push chain compatible with main session

#### [channel-plugin.ts](src/gateway/adapters/channel-plugin.ts)
- Channel plugin interface definition
- Defines interfaces all channel plugins must implement

---

### 7. Command Handling (`src/gateway/commands/`)

| File | Function |
|------|----------|
| [command-handler.ts](src/gateway/commands/command-handler.ts) | Command registration and execution |
| [session.ts](src/gateway/commands/session.ts) | /new, /reset, /stop, /compact |
| [status.ts](src/gateway/commands/status.ts) | /status, /whoami |
| [help.ts](src/gateway/commands/help.ts) | /help |
| [model.ts](src/gateway/commands/model.ts) | /model, /think, /reasoning |
| [context.ts](src/gateway/commands/context.ts) | /context |
| [tentacle.ts](src/gateway/commands/tentacle.ts) | /tentacles, /tentacle |
| [skill.ts](src/gateway/commands/skill.ts) | /skill |
| [cron.ts](src/gateway/commands/cron.ts) | /cron |

---

#### `/model` Behavior Supplement

In the current version, `/model`'s expected behavior is:

- Without arguments, reads the selected model for the current `sessionKey`
- `/model status` returns the current session's model, not the last model processed by Brain for another session
- `/model <provider/model>` resets the current session transcript and writes the new model selection back to that session's `sessions.json`

If "global default model switching" is needed in the future, it should be explicitly designed as a separate command, not reusing `/model`.

### 8. Tool System (`src/tools/`)

#### [index.ts](src/tools/index.ts)
- Tool registry (ToolRegistry)
- Manage all available tools

```typescript
class ToolRegistry {
  register(entry: ToolRegistryEntry): void
  getAll(): ToolRegistryEntry[]
  getPiTools(): ToolDefinition<any, any>[]
  // ...
}
```

#### Tool Implementation Files

| File | Function |
|------|----------|
| [memory-tools.ts](src/tools/memory-tools.ts) | Memory tools (read_memory, write_memory, etc.) |
| [user-tools.ts](src/tools/user-tools.ts) | User interaction tools (send_to_user, etc.) |
| [session-tools.ts](src/tools/session-tools.ts) | Session tools (session_reset, etc.) |
| [heartbeat-tools.ts](src/tools/heartbeat-tools.ts) | Heartbeat tools |
| [skill-tools.ts](src/tools/skill-tools.ts) | Skill tools |
| [web-tools.ts](src/tools/web-tools.ts) | Web tools (web_search, web_fetch) |
| [tentacle-tools.ts](src/tools/tentacle-tools.ts) | Tentacle tools |
| [code-tools.ts](src/tools/code-tools.ts) | Code tools |
| [cron-tools.ts](src/tools/cron-tools.ts) | Cron tools |

Supplementary notes:

- `send_to_user` in `user-tools.ts` now supports main session vs consultation / cron session routing
- `immediate` pushes are delivered immediately; `best_time` / `morning_digest` are written to the unified outbound queue
- Deferred messages from consultation source are written to main session transcript at actual delivery time

---

### 9. MCP Bridge (`src/mcp/`)

#### [mcp-bridge.ts](src/mcp/mcp-bridge.ts) — **Core File**
- Manage MCP server processes
- Expose MCP tools to Brain
- Support stdio transport
- Auto-reconnect mechanism

#### [tool-registry.ts](src/mcp/tool-registry.ts)
- MCP tool registry
- Convert to Pi tool format

#### [search-cache.ts](src/mcp/search-cache.ts)
- Search result cache
- TTL expiration mechanism

---

### 10. Memory System (`src/memory/`)

#### [memory-manager.ts](src/memory/memory-manager.ts)
- Memory manager
- Long-term memory read/write

#### [memory-search.ts](src/memory/memory-search.ts)
- Semantic search
- SQLite FTS5 full-text search

#### [memory-parser.ts](src/memory/memory-parser.ts)
- Memory parser
- Extract structured information from text

#### [memory-distiller.ts](src/memory/memory-distiller.ts)
- Memory distillation
- Extract key information

---

### 11. Tentacle System (`src/tentacle/`)

Tentacles are independently running processes representing the Brain's proactive execution capability.

#### [manager.ts](src/tentacle/manager.ts) — **Core File**
- Tentacle lifecycle management
- Process Spawn/Stop/Restart
- IPC communication
- Health tracking
- New version unifies tentacle `stdout` / `stderr` / `terminal` to `~/.openceph/tentacles/<id>/logs/`
- `resume()` now allows tentacles that are "known but not currently running" to re-spawn, no longer requiring the process to still be in the memory table

**Key Methods:**
```typescript
class TentacleManager {
  async spawn(tentacleId: string): Promise<void>
  async shutdown(): Promise<void>
  async kill(tentacleId: string): Promise<void>
  async pause(tentacleId: string): Promise<void>
  async resume(tentacleId: string): Promise<void>
  async triggerCronJob(jobId: string, tentacleId: string): Promise<boolean>
  async triggerHeartbeatReview(tentacleId: string, prompt: string, jobId: string): Promise<boolean>
  listAll(filter?: {...}): TentacleStatus[]
}
```

#### [registry.ts](src/tentacle/registry.ts)
- Tentacle registry
- Persist tentacle metadata

#### [ipc-server.ts](src/tentacle/ipc-server.ts)
- IPC server
- Unix Socket communication

#### [ipc-client.ts](src/tentacle/ipc-client.ts)
- IPC client (for use by tentacle processes)

#### [lifecycle.ts](src/tentacle/lifecycle.ts)
- Tentacle lifecycle manager
- Health adjustment (weaken/strengthen)

#### [health-score.ts](src/tentacle/health-score.ts)
- Health score calculator
- Based on report analysis

#### [review-engine.ts](src/tentacle/review-engine.ts)
- Tentacle review engine
- Auto-review and optimization

#### [pending-reports.ts](src/tentacle/pending-reports.ts)
- Pending report queue
- Report aggregation
- Consumed by daily review / digest scenarios

#### [contract.ts](src/tentacle/contract.ts)
- IPC message contract definitions
- Message type definitions

#### [runtime-detector.ts](src/tentacle/runtime-detector.ts)
- Runtime detection
- Detect tentacle process state

#### [tentacle-schedule.ts](src/tentacle/tentacle-schedule.ts)
- Tentacle schedule configuration

#### [consultation-session-store.ts](src/tentacle/consultation-session-store.ts)
- Consultation session storage
- Record user feedback

---

### 12. Cron System (`src/cron/`)

Scheduled task system.

#### [cron-scheduler.ts](src/cron/cron-scheduler.ts) — **Core File**
- Cron task scheduler
- Supports Cron expressions, fixed intervals, specified times

#### [cron-runner.ts](src/cron/cron-runner.ts)
- Cron task executor
- Actually runs task logic
- Built-in maintenance jobs: `daily-review`, `morning-digest-fallback`

#### [cron-store.ts](src/cron/cron-store.ts)
- Cron task persistent storage

#### [cron-types.ts](src/cron/cron-types.ts)
- Cron type definitions
- Job, Schedule, etc. interfaces

#### [time.ts](src/cron/time.ts)
- Time parsing utilities
- Parse ISO time, relative time

---

### 13. Heartbeat System (`src/heartbeat/`)

Active push system.

#### [heartbeat-runner.ts](src/heartbeat/heartbeat-runner.ts) — **Core File**
- Heartbeat executor
- Run heartbeat turns

#### [scheduler.ts](src/heartbeat/scheduler.ts)
- Heartbeat scheduler
- Manage heartbeat triggers

#### [task-manager.ts](src/heartbeat/task-manager.ts)
- Task manager
- Manage pending tasks

---

### 14. Push System (`src/push/`)

Push decision system.

#### [push-decision.ts](src/push/push-decision.ts) — **Core File**
- Push decision engine
- Decide when to push content

```typescript
class PushDecisionEngine {
  async evaluate(trigger: PushTrigger): Promise<PushDecision>
}
```

#### [outbound-queue.ts](src/push/outbound-queue.ts)
- Outbound queue
- Manage pending push items
- Unified storage of `ApprovedPushItem` and `DeferredMessage`
- `DeferredMessage` is used for `send_to_user(best_time/morning_digest)` deferred delivery

#### [dedup-engine.ts](src/push/dedup-engine.ts)
- Deduplication engine
- Deduplicate by URL and similarity

#### [push-delivery-state.ts](src/push/push-delivery-state.ts)
- Push delivery state tracking
- Record delivery history

#### [feedback-tracker.ts](src/push/feedback-tracker.ts)
- Feedback tracker
- Track user feedback on pushes

---

### 15. Skill System (`src/skills/`)

Dynamic skill system.

#### [skill-loader.ts](src/skills/skill-loader.ts)
- Skill loader
- Load skills from filesystem

#### [skill-spawner.ts](src/skills/skill-spawner.ts)
- Skill spawner
- Dynamically create new skills
- Supports deployment from skill_tentacle directory / `.tentacle` package
- Supports copying, config injection, deployment and incubation of builtin/community skill_tentacles
- From-zero generation path now does a fresh validator re-check before final failure, avoiding "disk already fixed but main flow still closes as failed"
- Return value carries the latest code-agent session / workdir / logs paths for troubleshooting incubation pipeline

#### [skill-inspector.ts](src/skills/skill-inspector.ts)
- Skill inspector
- Validate skill definitions

---

### 16. Code Agent (`src/code-agent/`)

#### [code-agent.ts](src/code-agent/code-agent.ts)
- Code execution agent
- Uses Claude Code to execute code
- `invoke_code_agent` semantics are now clearly defined as "generate/deploy code", default does not imply "already running"
- `generateSkillTentacle()` / `fixSkillTentacle()` / `deployExisting()` all now return session artifacts containing session file, workdir, logs paths
- `runWithPolling()` now fully streams `stdout/stderr/terminal` of each code-agent run to `~/.openceph/agents/code-agent/logs/runs/<session>/`

#### [deployer.ts](src/code-agent/deployer.ts)
- Code deployer
- Deploy code to target environment

#### [validator.ts](src/code-agent/validator.ts)
- Code validator

#### [claude-code-runner.ts](src/code-agent/claude-code-runner.ts)
- Claude Code runner

#### [types.ts](src/code-agent/types.ts)
- Code agent type definitions

---

### 17. Logging System (`src/logger/`)

#### [index.ts](src/logger/index.ts)
- Export all loggers
- At initialization, routes brain / gateway / code-agent / tentacle event logs to their respective directories

#### [create-logger.ts](src/logger/create-logger.ts)
- Logger creator
- Winston logging configuration
- Now ensures directories exist before creating DailyRotateFile, avoiding first-log-write failures due to missing parent directories

#### Logger Files

| File | Log Content |
|------|------------|
| [brain-logger.ts](src/logger/brain-logger.ts) | Brain conversation logs |
| [gateway-logger.ts](src/logger/gateway-logger.ts) | Gateway message routing logs |
| [system-logger.ts](src/logger/system-logger.ts) | System event logs |
| [cost-logger.ts](src/logger/cost-logger.ts) | API call cost logs |
| [tentacle-logger.ts](src/logger/tentacle-logger.ts) | Tentacle logs |
| [cache-trace-logger.ts](src/logger/cache-trace-logger.ts) | Prompt Cache hit records |

Supplementary notes:

- `brain-logger.ts` now writes to `~/.openceph/agents/ceph/logs/events-<date>.log`
- `gateway-logger.ts` now writes to `~/.openceph/agents/gateway/logs/events-<date>.log`
- `code-agent-logger.ts` now writes to `~/.openceph/agents/code-agent/logs/events-<date>.log`
- `tentacle-logger.ts` now writes to `~/.openceph/tentacles/<id>/logs/events-<date>.log`
- `process-runtime-capture.ts` is responsible for synchronously writing Ceph main process stdout/stderr to `stdout.log`, `stderr.log`, `terminal.log`
- `log-paths.ts` uniformly computes log paths under `agents/` and `tentacles/`

#### [runtime-status-store.ts](src/logger/runtime-status-store.ts)
- Runtime status store
- Records Brain/Gateway runtime status

---

### 18. Session Storage (`src/session/`)

#### [session-store.ts](src/session/session-store.ts)
- Session storage manager
- Persist conversation history
- `appendAssistantMessage()` supports cross-session append of assistant transcript
- Protected from concurrent writes via `proper-lockfile`

---

### 19. Auth System (`src/gateway/auth/`)

#### [auth-profiles.ts](src/gateway/auth/auth-profiles.ts)
- Auth profile management

#### [keychain.ts](src/gateway/auth/keychain.ts)
- macOS Keychain integration

---

### 20. Template Files (`src/templates/`)

#### [workspace/](src/templates/workspace/)
Workspace initialization templates:

| File | Purpose |
|------|---------|
| SOUL.md | Brain's core values and behavioral guidelines |
| AGENTS.md | Agent's specific behavioral rules |
| IDENTITY.md | Identity definition |
| USER.md | User information |
| HEARTBEAT.md | Active push behavior rules |
| TENTACLES.md | Tentacle configuration |
| MEMORY.md | Long-term memory |
| BOOTSTRAP.md | First-run bootstrap |

#### [openceph.json](src/templates/openceph.json)
- Default configuration template
- Includes complete configuration for `builtinTentacles`, `push`, `cron`, `heartbeat`, `loopDetection`, etc.

---

### 21. Built-in skill_tentacle (`builtin-tentacles/`)

These directories are automatically copied to `~/.openceph/skills/` during `openceph init`:

| Directory | Purpose |
|-----------|---------|
| `skill-tentacle-creator/` | Generate new skill_tentacle scaffold and perform local validation/packaging |
| `hn-radar/` | Hacker News monitoring, supports RSS + Algolia + optional LLM filtering |
| `github-release-watcher/` | GitHub Release / Tag monitoring |
| `daily-digest-curator/` | Aggregate pending items from state to generate daily digest |
| `arxiv-paper-scout/` | arXiv category / keyword monitoring with optional LLM quality judgment |
| `price-alert-monitor/` | Price change monitoring, supports multiple extraction methods |
| `uptime-watchdog/` | Availability and slow response monitoring |

Notes:

- The `builtin-tentacles/` in the repository is the source template
- `~/.openceph/skills/` is the installed copy, can be locally modified by the user
- `openceph upgrade` syncs new versions but does not overwrite user-modified `prompt/` by default

---

## Data Flow

### User Message Processing Flow

```
User → Channel Adapter → Gateway Router → Brain.handleMessage()
                                              ↓
                                        Pi Session
                                              ↓
                                    System Prompt Assembly
                                              ↓
                                        Model API Call
                                              ↓
                                    Tool Execution (if needed)
                                              ↓
                                        Response → Gateway → Channel → User
```

### Tentacle Lifecycle

```
Brain → TentacleManager.spawn() → Child Process (IPC)
                                        ↓
                              Tentacle runs task
                                        ↓
                              IPC Report → Brain
                                        ↓
                              Review/Health Check
                                        ↓
                              Decision (weaken/strengthen/kill)
```

### Push Decision Flow

```
Trigger (user_message/heartbeat/daily_review/urgent)
        ↓
PushDecisionEngine.evaluate()
        ↓
    ├─→ Check outbound queue
    ├─→ Deduplication
    ├─→ Priority sorting
    ├─→ Daily limit check
    └─→ Consolidated text → deliverToUser()
```

### consultation Push Dual-Write Flow

```
Tentacle consultation_request()
        ↓
Brain creates consultation session
        ↓
Tool: send_to_user()
        ↓
    ├─ immediate
    │    ├─ Gateway.deliverToUser()
    │    └─ SessionStore.appendAssistantMessage(main)
    │
    └─ best_time / morning_digest
         ├─ Write OutboundQueue.DeferredMessage
         ├─ Wait for user active window or morning fallback task
         └─ Write to main session at actual delivery time
```

---

## Key Configuration Files

### ~/.openceph/openceph.json

```json5
{
  // Gateway config
  gateway: { port: 18790, bind: "loopback" },

  // Channel config
  channels: {
    telegram: { enabled: false, dmPolicy: "pairing" },
    feishu: { enabled: false, dmPolicy: "pairing" },
    webchat: { enabled: true }
  },

  // Agent config
  agents: {
    defaults: {
      workspace: "~/.openceph/workspace",
      model: {
        primary: "openrouter/anthropic/claude-sonnet-4-5",
        fallbacks: ["openai/gpt-4o"]
      }
    }
  },

  // Auth config
  auth: { profiles: {...}, order: {...} },

  // MCP config
  mcp: { servers: {...}, webSearch: {...} },

  // Session config
  session: { mainKey: "main", reset: {...} },

  // Cron config
  cron: { store: "..." },

  // Heartbeat config
  heartbeat: { every: "6h", model: "..." },

  // Push config
  push: {
    defaultTiming: "best_time",
    preferredWindowStart: "09:00",
    preferredWindowEnd: "10:00",
    maxDailyPushes: 5,
    fallbackDigestTime: "09:00",
    fallbackDigestTz: "UTC"
  },

  // Built-in tentacle install config
  builtinTentacles: {
    autoInstallOnInit: true,
    autoUpgradeOnUpdate: true,
    skipList: []
  },

  // Tentacle config
  tentacle: { ipcSocketPath: "..." },

  // Logging config
  logging: { logDir: "...", cacheTrace: true }
}
```

---

## Dependencies

### Core Dependencies

| Package | Purpose |
|---------|---------|
| `@mariozechner/pi-agent-core` | Pi Agent core framework |
| `@mariozechner/pi-ai` | Pi AI abstraction layer |
| `@mariozechner/pi-coding-agent` | Pi code agent |
| `grammy` | Telegram Bot framework |
| `@larksuiteoapi/node-sdk` | Feishu SDK |
| `express` | Web server |
| `ws` | WebSocket |
| `node-cron` | Cron scheduling |
| `winston` | Logging framework |
| `zod` | Configuration validation |
| `json5` | JSON5 parsing |

---

## Running Modes

### 1. Development Mode
```bash
npm run dev -- start
```

### 2. CLI Chat Mode
```bash
npm run dev -- chat
```

### 3. Production Mode
```bash
npm run build
npm run start
```

### 4. Built-in Tentacle Sync
```bash
npm run dev -- upgrade
```

---

## Extension Development

### Adding a New Channel

1. Implement the `ChannelPlugin` interface (see `channel-plugin.ts`)
2. Register in `gateway.ts`:
   ```typescript
   gateway.registerChannel(new MyChannelPlugin())
   ```

### Adding a New Tool

1. Create a new file in `src/tools/`
2. Implement the tool function
3. Register in `brain.ts`'s `initialize()`

### Adding / Updating a Built-in skill_tentacle

1. Prepare `SKILL.md`, `README.md`, `prompt/`, `src/` under `builtin-tentacles/<name>/`
2. Ensure it passes `SkillInspector.validateSkillTentacle()` validation
3. If it's a Python tentacle, run at minimum:
   ```bash
   python3 -m py_compile builtin-tentacles/<name>/src/*.py
   ```
4. Run:
   ```bash
   npm test
   npm run build
   ```
5. To sync to local runtime directory:
   ```bash
   npm run dev -- upgrade
   ```

### Adding an MCP Server

Configure in `openceph.json`:
```json5
{
  mcp: {
    servers: {
      "my-server": {
        command: "npx",
        args: ["-y", "@my/mcp-server"]
      }
    }
  }
}
```

---

## Common Troubleshooting

### Viewing Logs
```bash
# Brain logs
tail -f ~/.openceph/logs/brain-$(date +%F).log

# Gateway logs
tail -f ~/.openceph/logs/gateway-$(date +%F).log

# System logs
tail -f ~/.openceph/logs/system-$(date +%F).log
```

Supplementary (2026-03 recommended troubleshooting path):

```bash
# Ceph main process event logs
tail -f ~/.openceph/agents/ceph/logs/events-$(date +%F).log

# Ceph main process full terminal stream
tail -f ~/.openceph/agents/ceph/logs/terminal.log

# code-agent event logs
tail -f ~/.openceph/agents/code-agent/logs/events-$(date +%F).log

# code-agent specific run full terminal stream
ls ~/.openceph/agents/code-agent/logs/runs/
tail -f ~/.openceph/agents/code-agent/logs/runs/<session>/terminal.log

# A specific tentacle's own logs
ls ~/.openceph/tentacles/<tentacle_id>/logs/
tail -f ~/.openceph/tentacles/<tentacle_id>/logs/terminal.log
tail -f ~/.openceph/tentacles/<tentacle_id>/logs/events-$(date +%F).log
```

### Checking Status
```bash
openceph status
```

### Health Check
```bash
openceph doctor
openceph doctor --fix
```

### Common Development Verification
```bash
npm test
npm run build
python3 -m py_compile builtin-tentacles/*/src/*.py
```

---

*Last updated 2026-03-22*
