# OpenCeph 代码库完全指南

## 概述

OpenCeph 是一个基于 Pi 框架的 AI 个人操作系统（Personal AI Operating System）。它允许用户通过多个渠道（Telegram、飞书、WebChat、CLI）与"大脑"（Brain）进行对话。大脑具有人格、记忆、会搜索，并支持完整的 Workspace 文件体系。

**核心特性：**
- 多渠道接入（Telegram、飞书、WebChat、CLI）
- 基于 Pi 框架的 Brain Agent，支持流式回复
- 记忆系统（长期记忆 MEMORY.md + 短期对话历史）
- 工具系统（大脑可以调用工具与外部世界交互）
- MCP 支持（接入 MCP 服务器扩展工具能力）
- 触手系统（Tentacles）- 大脑的主动执行能力
- 定时任务（Cron）和心跳推送（Heartbeat）
- 主动推送链路（consultation → `send_to_user` → 主 session / IM 投递）
- builtin skill_tentacle 自动安装与升级

---

## 项目结构总览

```
openceph/
├── builtin-tentacles/        # 内置 skill_tentacle（7 个）
├── src/                      # 源代码目录
│   ├── main.ts               # 完整启动流程（Gateway + Brain + 所有服务）
│   ├── cli.ts                # CLI 入口，所有命令行工具
│   ├── config/               # 配置系统
│   ├── pi/                   # Pi 框架封装
│   ├── brain/                # 大脑核心
│   ├── gateway/              # 网关（消息路由）
│   ├── tools/                # 工具系统
│   ├── mcp/                  # MCP 桥接
│   ├── memory/               # 记忆系统
│   ├── tentacle/            # 触手系统
│   ├── cron/                 # 定时任务系统
│   ├── heartbeat/            # 心跳推送系统
│   ├── push/                 # 推送决策系统
│   ├── skills/               # 技能系统
│   ├── code-agent/           # 代码执行代理
│   ├── logger/               # 日志系统
│   ├── session/              # 会话存储
│   └── templates/            # 模板文件
├── dist/                     # 编译输出
├── tests/                    # 测试
├── docs/                     # 文档
└── package.json
```

---

## 模块详解

### 1. 入口文件

#### [main.ts](src/main.ts)
完整启动流程，协调所有组件：
1. 设置全局代理（proxy-setup.ts）
2. 加载配置（config-loader.ts）
3. 初始化日志系统
4. 创建 Pi Context
5. 初始化 MCP Bridge
6. 创建并初始化 Brain
7. 注册 MCP 工具到 Brain
8. 创建并启动 Gateway
9. 注册渠道适配器（Telegram、飞书、WebChat、CLI）
10. 启动 Cron 调度器
11. 启动 Heartbeat 调度器
12. 启动 Session 重置调度器
13. 注册优雅退出处理

#### [cli.ts](src/cli.ts)
CLI 入口点，使用 Commander.js 实现所有命令行接口：

**子命令：**
| 命令 | 说明 |
|------|------|
| `init` | 初始化 OpenCeph（创建 ~/.openceph/ 目录结构） |
| `upgrade` | 同步 builtin tentacles 到 `~/.openceph/skills/` |
| `start` | 启动完整服务（Gateway + Brain + 所有渠道） |
| `chat` | CLI 对话模式（无 Gateway） |
| `pairing list/approve/reject/revoke` | 配对管理 |
| `credentials set/get/list/delete` | 凭据管理 |
| `cron list/add/edit/remove/run/runs` | Cron 任务管理 |
| `logs [type]` | 查看日志 |
| `status` | 显示系统状态 |
| `cost` | 显示成本摘要 |
| `doctor` | 系统健康检查 |
| `plugin list/install/uninstall` | 插件管理 |

---

### 2. 配置系统 (`src/config/`)

#### [config-loader.ts](src/config/config-loader.ts)
- 从 `~/.openceph/openceph.json` 加载配置（支持 JSON5 语法）
- 解析凭据引用（`from:credentials/xxx`、`env:VAR`、`keychain:service:key`）
- 使用 Zod 进行配置验证
- 展开路径中的 `~`

#### [config-schema.ts](src/config/config-schema.ts)
- 定义完整的配置 schema（使用 Zod）
- 包含：gateway、channels、agents、models、auth、mcp、session、cron、heartbeat、push、tentacle、skills、logging、cost 等配置项

补充：
- `tentacle.model` / `tentacle.models` / `tentacle.providers` / `tentacle.auth` 组成触手独立运行时配置
- 触手模型解析逻辑在 `src/config/model-runtime.ts`
- 业务代码开发在仓库内完成，但运行时配置来源仍然是 `~/.openceph/openceph.json`

#### 配置迁移经验（2026-03 Hotfix）

当用户已经运行过多轮旧版本、`~/.openceph/agents/**/sessions.json` 中残留旧模型、或 `state/` 与当前源码行为不一致时，推荐的运维动作不是直接修旧目录，而是：

1. 停掉当前 `start` 进程
2. 整体备份 `~/.openceph/`
3. 重新执行 `openceph init`
4. 用 `credentials set` 恢复 OpenRouter / 飞书等关键凭据
5. 只编辑新生成的 `~/.openceph/openceph.json`

这条流程应该写进所有运维/排障 SOP，因为它能同时规避旧 `sessions/`、旧 `state/`、旧模板、旧触手部署目录带来的串扰。

#### [credential-store.ts](src/config/credential-store.ts)
- 凭据存储和管理
- 支持从文件、环境变量、macOS Keychain 读取凭据

#### [proxy-setup.ts](src/config/proxy-setup.ts)
- 设置全局 HTTP/HTTPS 代理
- 支持从环境变量 `HTTP_PROXY`/`HTTPS_PROXY` 读取代理配置

---

### 3. Pi 框架封装 (`src/pi/`)

基于 `@mariozechner/pi-agent-core` 封装。

#### [pi-context.ts](src/pi/pi-context.ts)
- 创建和管理 Pi Context
- 初始化 Pi 框架的核心组件
- 注册 Pi Extensions：`memory-injector`、`context-pruner`、`push-message-merger`、`compaction-guard`

#### [pi-session.ts](src/pi/pi-session.ts)
- 创建 Brain Session
- 管理对话会话状态

#### [pi-models.ts](src/pi/pi-models.ts)
- 定义支持的模型列表
- 包含 Anthropic 和 OpenAI 模型定义

#### [pi-auth.ts](src/pi/pi-auth.ts)
- 认证配置管理
- 支持 API Key 认证

#### [model-resolver.ts](src/pi/model-resolver.ts)
- 模型解析和选择
- 处理模型可用性检查

---

### 4. 大脑核心 (`src/brain/`)

这是系统的核心，处理 AI 对话逻辑。

#### [brain.ts](src/brain/brain.ts) — **核心文件**
Brain 类的完整实现，主要功能：

- **对话处理** (`handleMessage`)：处理用户消息，执行对话轮次
- **工具注册**：注册各类工具（memory、user、session、heartbeat、skill、web、tentacle、code、cron、mcp）
- **系统提示构建**：动态组装系统提示词
- **会话管理**：创建、重置会话
- **模型切换**：支持模型故障转移
- **上下文压缩**：支持上下文压缩减少 token 使用
- **心跳处理** (`runHeartbeatTurn`)：处理定时心跳
- **触手集成**：与触手系统交互
- **推送决策**：评估是否推送内容给用户
- **延迟投递**：处理 `best_time` / `morning_digest` 队列
- **跨 session 双写**：consultation 来源推送在真正投递时写入主 session
- **日/周回顾**：自动执行回顾任务

#### 模型选择 Hotfix（2026-03）

这一轮修复后，Brain 的模型选择逻辑有两个重要变化：

- `handleMessage()` 不再直接信任一个全局 `currentModel` 作为所有会话的默认来源，而是先按 `sessionKey` 解析该 session 当前选中的模型
- 当 `sessionKey` 或模型变化时，会丢弃内存中的旧 Pi session，并按新的 transcript / model 重建 session

这样做的原因是：旧实现会把“当前模型”做成进程级全局状态，导致 A 会话通过 `/model` 切换后，B 会话也被连带切换；同时 `sessions.json` 中的 `model` 元数据可能与真实会话使用的模型脱节。

当前实现约束：

- `~/.openceph/openceph.json` 中的 `agents.defaults.model.primary` 是默认模型来源
- `/model` 只影响当前 session
- `SessionStoreManager.updateModel()` 会把当前 session 选中的模型写回 `~/.openceph/agents/<agent>/sessions/sessions.json`
- Brain 的自动 failover 不再直接把 session 从一个模型静默切到另一个模型；默认需要显式 `/model`

**关键方法：**
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
  // ... 更多方法
}
```

#### [system-prompt.ts](src/brain/system-prompt.ts)
- 组装系统提示词
- 从 Workspace 文件（SOUL.md、AGENTS.md 等）读取提示内容

#### [context-assembler.ts](src/brain/context-assembler.ts)
- 上下文组装器
- 检查是否为新 Workspace

#### [extensions/](src/brain/extensions/)
- `memory-injector.ts`：记忆注入扩展
- `context-pruner.ts`：上下文修剪扩展
- `push-message-merger.ts`：运行时合并连续 assistant 消息
- `compaction-guard.ts`：压缩保护扩展

#### 主动推送链路补充

Phase 7 后，触手推送链路不再只是“调用 Gateway 发消息”，而是完整经过：

1. 触手通过 `consultation_request` 向大脑上报
2. 大脑在 consultation / cron session 中决定是否调用 `send_to_user`
3. `send_to_user` 在 consultation 来源下执行跨 session 双写
4. 消息写入主 session transcript，metadata 标记为 `tentacle_push`
5. Gateway 立即投递，或进入 `best_time` / `morning_digest` 队列
6. API 调用前由 `push-message-merger` 合并连续 assistant 消息，避免上下文格式冲突

这意味着“用户回复触手推送内容”时，大脑能在主 session 中自然看到那条历史推送。

### 4.1 触手部署链路 Hotfix（Phase 8）

这轮修复的重点不是新增产品能力，而是把原先不通的触手链路打通：

- IPC 协议统一为 `stdin/stdout JSON Lines`
  运行时在 `src/tentacle/manager.ts` 用 `stdio: ["pipe","pipe","pipe"]` 启动触手
  `src/tentacle/ipc-server.ts` 现在优先解析子进程 stdout，并通过 stdin 下发 directive
- `.env` / credentials 解析修复
  `src/skills/skill-spawner.ts` 不再把 `OPENROUTER_API_KEY` 机械映射成错误路径
  缺失必需凭据时直接阻止启动并返回友好错误
- 代码部署路径修复
  `src/code-agent/deployer.ts` 改成部署前清空旧目录（保留 `.env` / `data` / 日志）
  部署后会校验入口文件真实存在，避免 workdir 与 runtime dir 脱节

这三个点是之前 HN / arXiv 需求在日志里不断 fallback 到 cron 的直接根因。

### 4.2 运行状态与日志 Hotfix（2026-03）

这一轮又补了两类基础设施约束：

- **状态语义硬分离**
  `generated`、`deployed`、`spawned`、`registered/running` 必须视为不同阶段
  `src/brain/system-prompt.ts`、`src/brain/brain.ts`、workspace `AGENTS.md` 都新增了“禁止把 deployed 说成 running”的规则
- **日志目录重构**
  Ceph / Gateway / code-agent 迁移到 `~/.openceph/agents/<agent>/logs/`
  触手迁移到 `~/.openceph/tentacles/<tentacle_id>/logs/`
  code-agent 单次运行现在额外生成 `runs/<session>/stdout.log`、`stderr.log`、`terminal.log`

这次修复的目标不是换一套日志框架，而是把“谁的日志写到哪里”彻底收口，方便定位 HN 这类孵化/运行问题。

#### [loop-detection.ts](src/brain/loop-detection.ts)
- 检测工具调用循环
- 防止无限循环

#### [failover.ts](src/brain/failover.ts)
- 模型故障转移逻辑
- 上下文限制检查

---

### 5. 网关系统 (`src/gateway/`)

负责消息路由和渠道接入。

#### [gateway.ts](src/gateway/gateway.ts) — **核心文件**
- 管理系统中所有渠道适配器
- 协调消息路由
- 管理插件热加载

**关键功能：**
- `registerChannel()`：注册渠道插件
- `deliverToUser()`：向用户发送消息
- `start()`/`stop()`：启动/停止网关

补充说明（2026-03）：

- `gateway_start` 只代表渠道插件初始化成功，并不等于每个渠道都一定暴露同一个端口
- WebChat 实际监听端口以 `channel_start` 日志中的 `webchat.port` 为准
- 如果运维脚本只检查 `runtime-status.json.gateway.port`，可能会误判当前实际可连接的 WebChat 端口；排障时应同时看 `gateway-*.log`

#### [router.ts](src/gateway/router.ts)
- 消息路由器
- 决定消息如何被处理

#### [session-manager.ts](src/gateway/session-manager.ts)
- Session 解析和解析器
- 管理会话键（sessionKey）

#### [session-store.ts](src/session/session-store.ts)
- 持久化 `sessions.json`
- 保存 session transcript 路径、token 统计、origin，以及当前 session 选中的模型

2026-03 之后，这里的 `model` 字段语义建议明确理解为：

- 不是“系统全局当前模型”
- 不是“Pi transcript 中最后一次 message_complete 的 provider/model 快照”
- 而是“这个 session 下一轮应该继续使用的选中模型”

这也是 README 中“不要直接修旧 sessions.json，优先重建 `~/.openceph/`”的根本原因：旧版本留下的 `model` 字段可能并不可靠

#### [message-queue.ts](src/gateway/message-queue.ts)
- 消息队列管理
- 消息缓冲和限流

#### [pairing.ts](src/gateway/pairing.ts)
- 配对系统管理
- 新用户审批流程

#### [session-reset.ts](src/gateway/session-reset.ts)
- Session 自动重置调度器
- 支持每日重置和空闲重置

#### [plugin-loader.ts](src/gateway/plugin-loader.ts)
- 动态加载扩展渠道插件
- 支持热加载

---

### 6. 渠道适配器 (`src/gateway/adapters/`)

#### [telegram/](src/gateway/adapters/telegram/)
- Telegram Bot 集成
- 使用 `grammy` 框架
- 消息格式化器

#### [feishu/](src/gateway/adapters/feishu/)
- 飞书消息卡片集成
- 使用 `@larksuiteoapi/node-sdk`
- 消息格式化器

#### [webchat/](src/gateway/adapters/webchat/)
- WebSocket Web Chat 服务
- Express + ws 实现

#### [cli/](src/gateway/adapters/cli/)
- 本地 CLI 对话适配器
- 使用 readline 实现交互

---

## 触手开发注意事项

### 1. 运行时协议

- 新触手统一使用 `stdin/stdout JSON Lines`
- `stdout` 只能输出 IPC 消息，业务日志必须写 `stderr`
- `OPENCEPH_TENTACLE_ID` 和 `OPENCEPH_TRIGGER_MODE` 由运行时注入
- 不要再在新代码里依赖 `OPENCEPH_SOCKET_PATH` / `OPENCEPH_IPC_SOCKET`

### 2. 配置来源

- 不能直接把运行时密钥写进仓库
- 触手依赖的 provider / auth / model 由 `~/.openceph/openceph.json` 中的 `tentacle.*` 配置控制
- skill_tentacle 的自定义字段和必需环境变量由 `SkillSpawner.injectUserConfig()` 注入到运行目录 `.env`

### 3. 内置触手

`builtin-tentacles/` 下的触手现在可以作为 phase7 的参考实现：

- `hn-radar`
- `arxiv-paper-scout`
- `github-release-watcher`
- `daily-digest-curator`
- `price-alert-monitor`
- `uptime-watchdog`
- `skill-tentacle-creator`

其中 HN / arXiv 两个 builtin 已补齐：

- `stdin/stdout` IPC 客户端
- `pause` / `resume` / `kill` / `run_now` 指令处理
- 与主 session 的 consultation → push 全链路兼容

#### [channel-plugin.ts](src/gateway/adapters/channel-plugin.ts)
- 渠道插件接口定义
- 定义所有渠道插件必须实现的接口

---

### 7. 命令处理 (`src/gateway/commands/`)

| 文件 | 功能 |
|------|------|
| [command-handler.ts](src/gateway/commands/command-handler.ts) | 命令注册和执行 |
| [session.ts](src/gateway/commands/session.ts) | /new, /reset, /stop, /compact |
| [status.ts](src/gateway/commands/status.ts) | /status, /whoami |
| [help.ts](src/gateway/commands/help.ts) | /help |
| [model.ts](src/gateway/commands/model.ts) | /model, /think, /reasoning |
| [context.ts](src/gateway/commands/context.ts) | /context |
| [tentacle.ts](src/gateway/commands/tentacle.ts) | /tentacles, /tentacle |
| [skill.ts](src/gateway/commands/skill.ts) | /skill |
| [cron.ts](src/gateway/commands/cron.ts) | /cron |

---

#### `/model` 行为补充

当前版本里 `/model` 的预期行为是：

- 不带参数时，读取当前 `sessionKey` 对应的选中模型
- `/model status` 返回当前 session 的模型，而不是 Brain 进程上一次处理过的其他会话模型
- `/model <provider/model>` 会重置当前 session transcript，并把新的模型选择写回该 session 的 `sessions.json`

如果未来需要支持“全局默认模型切换”，应该显式设计成另一条命令，而不是复用 `/model`

### 8. 工具系统 (`src/tools/`)

#### [index.ts](src/tools/index.ts)
- 工具注册表（ToolRegistry）
- 管理所有可用工具

```typescript
class ToolRegistry {
  register(entry: ToolRegistryEntry): void
  getAll(): ToolRegistryEntry[]
  getPiTools(): ToolDefinition<any, any>[]
  // ...
}
```

#### 工具实现文件

| 文件 | 功能 |
|------|------|
| [memory-tools.ts](src/tools/memory-tools.ts) | 记忆工具（read_memory, write_memory 等） |
| [user-tools.ts](src/tools/user-tools.ts) | 用户交互工具（send_to_user 等） |
| [session-tools.ts](src/tools/session-tools.ts) | 会话工具（session_reset 等） |
| [heartbeat-tools.ts](src/tools/heartbeat-tools.ts) | 心跳工具 |
| [skill-tools.ts](src/tools/skill-tools.ts) | 技能工具 |
| [web-tools.ts](src/tools/web-tools.ts) | 网页工具（web_search, web_fetch） |
| [tentacle-tools.ts](src/tools/tentacle-tools.ts) | 触手工具 |
| [code-tools.ts](src/tools/code-tools.ts) | 代码工具 |
| [cron-tools.ts](src/tools/cron-tools.ts) | Cron 工具 |

补充说明：

- `user-tools.ts` 中的 `send_to_user` 已支持主 session 与 consultation / cron session 分流
- `immediate` 推送会立即投递；`best_time` / `morning_digest` 会写入统一出站队列
- consultation 来源的延迟消息会在真正投递时写入主 session transcript

---

### 9. MCP 桥接 (`src/mcp/`)

#### [mcp-bridge.ts](src/mcp/mcp-bridge.ts) — **核心文件**
- 管理 MCP 服务器进程
- 暴露 MCP 工具给 Brain
- 支持 stdio 传输
- 自动重连机制

#### [tool-registry.ts](src/mcp/tool-registry.ts)
- MCP 工具注册
- 转换为 Pi 工具格式

#### [search-cache.ts](src/mcp/search-cache.ts)
- 搜索结果缓存
- TTL 过期机制

---

### 10. 记忆系统 (`src/memory/`)

#### [memory-manager.ts](src/memory/memory-manager.ts)
- 记忆管理器
- 长期记忆读写

#### [memory-search.ts](src/memory/memory-search.ts)
- 语义搜索
- SQLite FTS5 全文搜索

#### [memory-parser.ts](src/memory/memory-parser.ts)
- 记忆解析
- 从文本提取结构化信息

#### [memory-distiller.ts](src/memory/memory-distiller.ts)
- 记忆蒸馏
- 提取关键信息

---

### 11. 触手系统 (`src/tentacle/`)

触手（Tentacle）是独立运行的进程，代表大脑的主动执行能力。

#### [manager.ts](src/tentacle/manager.ts) — **核心文件**
- 触手生命周期管理
- 进程 Spawn/Stop/Restart
- IPC 通信
- 健康度跟踪
- 新版会把触手 `stdout` / `stderr` / `terminal` 统一写入 `~/.openceph/tentacles/<id>/logs/`
- `resume()` 现在允许“已知但当前未运行”的触手重新 spawn，而不再要求进程还留在内存表里

**关键方法：**
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
- 触手注册表
- 持久化触手元数据

#### [ipc-server.ts](src/tentacle/ipc-server.ts)
- IPC 服务器
- Unix Socket 通信

#### [ipc-client.ts](src/tentacle/ipc-client.ts)
- IPC 客户端（供触手进程使用）

#### [lifecycle.ts](src/tentacle/lifecycle.ts)
- 触手生命周期管理器
- 健康度调整（weaken/strengthen）

#### [health-score.ts](src/tentacle/health-score.ts)
- 健康度计算器
- 基于报告分析

#### [review-engine.ts](src/tentacle/review-engine.ts)
- 触手审查引擎
- 自动审查和优化

#### [pending-reports.ts](src/tentacle/pending-reports.ts)
- 待处理报告队列
- 报告聚合
- 供 daily review / digest 场景消费

#### [contract.ts](src/tentacle/contract.ts)
- IPC 消息契约定义
- 消息类型定义

#### [runtime-detector.ts](src/tentacle/runtime-detector.ts)
- 运行时检测
- 检测触手进程状态

#### [tentacle-schedule.ts](src/tentacle/tentacle-schedule.ts)
- 触手调度配置

#### [consultation-session-store.ts](src/tentacle/consultation-session-store.ts)
- 咨询会话存储
- 记录用户反馈

---

### 12. Cron 系统 (`src/cron/`)

定时任务系统。

#### [cron-scheduler.ts](src/cron/cron-scheduler.ts) — **核心文件**
- Cron 任务调度器
- 支持 Cron 表达式、固定间隔、指定时间

#### [cron-runner.ts](src/cron/cron-runner.ts)
- Cron 任务执行器
- 实际运行任务逻辑
- 内置 maintenance job：`daily-review`、`morning-digest-fallback`

#### [cron-store.ts](src/cron/cron-store.ts)
- Cron 任务持久化存储

#### [cron-types.ts](src/cron/cron-types.ts)
- Cron 类型定义
- Job、Schedule 等接口

#### [time.ts](src/cron/time.ts)
- 时间解析工具
- 解析 ISO 时间、相对时间

---

### 13. Heartbeat 系统 (`src/heartbeat/`)

主动推送系统。

#### [heartbeat-runner.ts](src/heartbeat/heartbeat-runner.ts) — **核心文件**
- Heartbeat 执行器
- 运行心跳轮次

#### [scheduler.ts](src/heartbeat/scheduler.ts)
- Heartbeat 调度器
- 管理心跳触发

#### [task-manager.ts](src/heartbeat/task-manager.ts)
- 任务管理器
- 管理待执行任务

---

### 14. Push 系统 (`src/push/`)

推送决策系统。

#### [push-decision.ts](src/push/push-decision.ts) — **核心文件**
- 推送决策引擎
- 决定何时推送内容

```typescript
class PushDecisionEngine {
  async evaluate(trigger: PushTrigger): Promise<PushDecision>
}
```

#### [outbound-queue.ts](src/push/outbound-queue.ts)
- 出站队列
- 管理待推送项目
- 统一存储 `ApprovedPushItem` 和 `DeferredMessage`
- `DeferredMessage` 用于 `send_to_user(best_time/morning_digest)` 的延迟投递

#### [dedup-engine.ts](src/push/dedup-engine.ts)
- 去重引擎
- 基于 URL 和相似度去重

#### [push-delivery-state.ts](src/push/push-delivery-state.ts)
- 推送投递状态跟踪
- 记录投递历史

#### [feedback-tracker.ts](src/push/feedback-tracker.ts)
- 反馈跟踪器
- 追踪用户对推送的反馈

---

### 15. 技能系统 (`src/skills/`)

动态技能系统。

#### [skill-loader.ts](src/skills/skill-loader.ts)
- 技能加载器
- 从文件系统中加载技能

#### [skill-spawner.ts](src/skills/skill-spawner.ts)
- 技能生成器
- 动态创建新技能
- 支持从 skill_tentacle 目录 / `.tentacle` 包部署
- 支持 builtin/community skill_tentacle 的复制、注入配置、部署和孵化
- 从零生成路径现在会在最终失败前做一次 fresh validator 复核，避免“磁盘已修好但主流程仍按失败收口”
- 返回值会携带最近一次 code-agent session / workdir / logs 路径，便于排查孵化链路

#### [skill-inspector.ts](src/skills/skill-inspector.ts)
- 技能检查器
- 验证技能定义

---

### 16. 代码代理 (`src/code-agent/`)

#### [code-agent.ts](src/code-agent/code-agent.ts)
- 代码执行代理
- 使用 Claude Code 执行代码
- `invoke_code_agent` 的语义现在明确为“生成/部署代码”，默认不会暗示“已经运行”
- `generateSkillTentacle()` / `fixSkillTentacle()` / `deployExisting()` 现在都会返回 session artifact，包含 session file、workdir、logs 路径
- `runWithPolling()` 现在把每次 code-agent 运行的完整 `stdout/stderr/terminal` 流落到 `~/.openceph/agents/code-agent/logs/runs/<session>/`

#### [deployer.ts](src/code-agent/deployer.ts)
- 代码部署器
- 部署代码到目标环境

#### [validator.ts](src/code-agent/validator.ts)
- 代码验证器

#### [claude-code-runner.ts](src/code-agent/claude-code-runner.ts)
- Claude Code 运行器

#### [types.ts](src/code-agent/types.ts)
- 代码代理类型定义

---

### 17. 日志系统 (`src/logger/`)

#### [index.ts](src/logger/index.ts)
- 导出所有日志器
- 初始化时会把 brain / gateway / code-agent / tentacle 的事件日志分别路由到各自目录

#### [create-logger.ts](src/logger/create-logger.ts)
- 日志创建器
- Winston 日志配置
- 现在会在创建 DailyRotateFile 之前确保目录存在，避免首次写日志时因为父目录缺失而失败

#### 各日志器文件

| 文件 | 日志内容 |
|------|----------|
| [brain-logger.ts](src/logger/brain-logger.ts) | Brain 对话日志 |
| [gateway-logger.ts](src/logger/gateway-logger.ts) | Gateway 消息路由日志 |
| [system-logger.ts](src/logger/system-logger.ts) | 系统事件日志 |
| [cost-logger.ts](src/logger/cost-logger.ts) | API 调用成本日志 |
| [tentacle-logger.ts](src/logger/tentacle-logger.ts) | 触手日志 |
| [cache-trace-logger.ts](src/logger/cache-trace-logger.ts) | Prompt Cache 命中记录 |

补充：

- `brain-logger.ts` 现在写入 `~/.openceph/agents/ceph/logs/events-<date>.log`
- `gateway-logger.ts` 现在写入 `~/.openceph/agents/gateway/logs/events-<date>.log`
- `code-agent-logger.ts` 现在写入 `~/.openceph/agents/code-agent/logs/events-<date>.log`
- `tentacle-logger.ts` 现在写入 `~/.openceph/tentacles/<id>/logs/events-<date>.log`
- `process-runtime-capture.ts` 负责把 Ceph 主进程 stdout/stderr 同步写入 `stdout.log`、`stderr.log`、`terminal.log`
- `log-paths.ts` 统一计算 `agents/` 与 `tentacles/` 下的日志路径

#### [runtime-status-store.ts](src/logger/runtime-status-store.ts)
- 运行时状态存储
- 记录 Brain/Gateway 运行状态

---

### 18. 会话存储 (`src/session/`)

#### [session-store.ts](src/session/session-store.ts)
- 会话存储管理器
- 持久化对话历史
- `appendAssistantMessage()` 支持跨 session 追加 assistant transcript
- 通过 `proper-lockfile` 保护并发写入

---

### 19. 认证系统 (`src/gateway/auth/`)

#### [auth-profiles.ts](src/gateway/auth/auth-profiles.ts)
- 认证配置文件管理

#### [keychain.ts](src/gateway/auth/keychain.ts)
- macOS Keychain 集成

---

### 20. 模板文件 (`src/templates/`)

#### [workspace/](src/templates/workspace/)
Workspace 初始化模板：

| 文件 | 用途 |
|------|------|
| SOUL.md | 大脑的核心价值观和行为准则 |
| AGENTS.md | Agent 的具体行为规范 |
| IDENTITY.md | 身份定义 |
| USER.md | 用户信息 |
| HEARTBEAT.md | 主动推送行为规则 |
| TENTACLES.md | 触手配置 |
| MEMORY.md | 长期记忆 |
| BOOTSTRAP.md | 首次运行引导 |

#### [openceph.json](src/templates/openceph.json)
- 默认配置模板
- 已包含 `builtinTentacles`、`push`、`cron`、`heartbeat`、`loopDetection` 等完整配置

---

### 21. 内置 skill_tentacle (`builtin-tentacles/`)

这些目录会在 `openceph init` 时自动复制到 `~/.openceph/skills/`：

| 目录 | 用途 |
|------|------|
| `skill-tentacle-creator/` | 生成新的 skill_tentacle 脚手架并做本地校验/打包 |
| `hn-radar/` | Hacker News 监控，支持 RSS + Algolia + 可选 LLM 过滤 |
| `github-release-watcher/` | GitHub Release / Tag 监控 |
| `daily-digest-curator/` | 从 state 中聚合待处理项生成每日简报 |
| `arxiv-paper-scout/` | arXiv 分类 / 关键词监控与可选 LLM 质量判断 |
| `price-alert-monitor/` | 价格变化监控，支持多种抽取方式 |
| `uptime-watchdog/` | 可用性和慢响应监控 |

说明：

- 仓库中的 `builtin-tentacles/` 是源模板
- `~/.openceph/skills/` 是已安装副本，可被用户本地修改
- `openceph upgrade` 会同步新版本，但默认不覆盖用户修改过的 `prompt/`

---

## 数据流

### 用户消息处理流程

```
用户 → Channel Adapter → Gateway Router → Brain.handleMessage()
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

### 触手生命周期

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

### 推送决策流程

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

### consultation 推送双写流程

```
Tentacle consultation_request()
        ↓
Brain 创建 consultation session
        ↓
Tool: send_to_user()
        ↓
    ├─ immediate
    │    ├─ Gateway.deliverToUser()
    │    └─ SessionStore.appendAssistantMessage(main)
    │
    └─ best_time / morning_digest
         ├─ 写入 OutboundQueue.DeferredMessage
         ├─ 等待用户活跃窗口或晨间兜底任务
         └─ 真正投递时再写入主 session
```

---

## 关键配置文件

### ~/.openceph/openceph.json

```json5
{
  // 网关配置
  gateway: { port: 18790, bind: "loopback" },

  // 渠道配置
  channels: {
    telegram: { enabled: false, dmPolicy: "pairing" },
    feishu: { enabled: false, dmPolicy: "pairing" },
    webchat: { enabled: true }
  },

  // Agent 配置
  agents: {
    defaults: {
      workspace: "~/.openceph/workspace",
      model: {
        primary: "openrouter/anthropic/claude-sonnet-4-5",
        fallbacks: ["openai/gpt-4o"]
      }
    }
  },

  // 认证配置
  auth: { profiles: {...}, order: {...} },

  // MCP 配置
  mcp: { servers: {...}, webSearch: {...} },

  // 会话配置
  session: { mainKey: "main", reset: {...} },

  // Cron 配置
  cron: { store: "..." },

  // Heartbeat 配置
  heartbeat: { every: "6h", model: "..." },

  // Push 配置
  push: {
    defaultTiming: "best_time",
    preferredWindowStart: "09:00",
    preferredWindowEnd: "10:00",
    maxDailyPushes: 5,
    fallbackDigestTime: "09:00",
    fallbackDigestTz: "UTC"
  },

  // 内置触手安装配置
  builtinTentacles: {
    autoInstallOnInit: true,
    autoUpgradeOnUpdate: true,
    skipList: []
  },

  // Tentacle 配置
  tentacle: { ipcSocketPath: "..." },

  // 日志配置
  logging: { logDir: "...", cacheTrace: true }
}
```

---

## 依赖项

### 核心依赖

| 包 | 用途 |
|----|------|
| `@mariozechner/pi-agent-core` | Pi Agent 核心框架 |
| `@mariozechner/pi-ai` | Pi AI 抽象层 |
| `@mariozechner/pi-coding-agent` | Pi 代码代理 |
| `grammy` | Telegram Bot 框架 |
| `@larksuiteoapi/node-sdk` | 飞书 SDK |
| `express` | Web 服务器 |
| `ws` | WebSocket |
| `node-cron` | Cron 调度 |
| `winston` | 日志框架 |
| `zod` | 配置验证 |
| `json5` | JSON5 解析 |

---

## 运行模式

### 1. 开发模式
```bash
npm run dev -- start
```

### 2. CLI 对话模式
```bash
npm run dev -- chat
```

### 3. 生产模式
```bash
npm run build
npm run start
```

### 4. builtin tentacle 同步
```bash
npm run dev -- upgrade
```

---

## 扩展开发

### 添加新渠道

1. 实现 `ChannelPlugin` 接口（参考 `channel-plugin.ts`）
2. 在 `gateway.ts` 中注册：
   ```typescript
   gateway.registerChannel(new MyChannelPlugin())
   ```

### 添加新工具

1. 在 `src/tools/` 创建新文件
2. 实现工具函数
3. 在 `brain.ts` 的 `initialize()` 中注册

### 新增 / 更新 builtin skill_tentacle

1. 在 `builtin-tentacles/<name>/` 下准备 `SKILL.md`、`README.md`、`prompt/`、`src/`
2. 确保可通过 `SkillInspector.validateSkillTentacle()` 验证
3. 若为 Python 触手，至少运行：
   ```bash
   python3 -m py_compile builtin-tentacles/<name>/src/*.py
   ```
4. 执行：
   ```bash
   npm test
   npm run build
   ```
5. 若要同步到本地运行目录：
   ```bash
   npm run dev -- upgrade
   ```

### 添加 MCP 服务器

在 `openceph.json` 配置：
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

## 常见问题排查

### 查看日志
```bash
# Brain 日志
tail -f ~/.openceph/logs/brain-$(date +%F).log

# Gateway 日志
tail -f ~/.openceph/logs/gateway-$(date +%F).log

# 系统日志
tail -f ~/.openceph/logs/system-$(date +%F).log
```

补充（2026-03 推荐排障路径）：

```bash
# Ceph 主进程事件日志
tail -f ~/.openceph/agents/ceph/logs/events-$(date +%F).log

# Ceph 主进程完整终端流
tail -f ~/.openceph/agents/ceph/logs/terminal.log

# code-agent 事件日志
tail -f ~/.openceph/agents/code-agent/logs/events-$(date +%F).log

# code-agent 某次运行的完整终端流
ls ~/.openceph/agents/code-agent/logs/runs/
tail -f ~/.openceph/agents/code-agent/logs/runs/<session>/terminal.log

# 某个触手自己的日志
ls ~/.openceph/tentacles/<tentacle_id>/logs/
tail -f ~/.openceph/tentacles/<tentacle_id>/logs/terminal.log
tail -f ~/.openceph/tentacles/<tentacle_id>/logs/events-$(date +%F).log
```

### 检查状态
```bash
openceph status
```

### 健康检查
```bash
openceph doctor
openceph doctor --fix
```

### 常用开发验证
```bash
npm test
npm run build
python3 -m py_compile builtin-tentacles/*/src/*.py
```

---

*本文档最后更新于 2026-03-22*
