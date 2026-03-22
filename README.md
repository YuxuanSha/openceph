# OpenCeph

OpenCeph 是一个基于 Pi 框架的 AI 个人操作系统，让你可以透过多个渠道（Telegram、飞书、WebChat、CLI）与你的"大脑"对话。大脑拥有人格、记忆、会搜索，并支持完整的 Workspace 文件体系。

当前代码库已经包含主动推送链路、触手系统、Cron / Heartbeat 调度、技能孵化和内置 skill_tentacle。`openceph init` 后会自动安装一组开箱即用的内置触手，支持信息监控、每日简报、价格提醒、可用性监控等场景。

## 功能特性

### 已完成 (Phase 0 + Phase 1)

- **多渠道接入**: Telegram、飞书、WebChat、CLI
- **AI 对话**: 基于 Pi 框架的 Brain Agent，支持流式回复
- **记忆系统**: 长期记忆（MEMORY.md）和短期对话历史
- **工具系统**: 大脑可以调用工具与外部世界交互
- **MCP 支持**: 接入 MCP 服务器扩展工具能力（如网页搜索）
- **Session 管理**: 支持 `/new` 创建新对话、每日重置、空闲重置
- **配对系统**: 新用户需要审批才能对话（pairing 流程）
- **成本追踪**: 记录每次 API 调用的 token 消耗
- **Prompt Cache**: 支持 Anthropic 的 prompt caching，降低成本

### 新增能力 (Phase 2 ~ Phase 7)

- **触手系统**: Brain 可孵化、运行、暂停、恢复、销毁独立 Tentacle 进程
- **主动推送**: 触手发现可通过 `send_to_user` 进入主 session 并投递到 IM 渠道
- **跨 Session 双写**: consultation / cron session 中的推送会在投递时写入主 session transcript
- **消息合并**: 连续 assistant 推送会在 API 请求前运行时合并，避免上下文格式冲突
- **推送队列**: 支持 `immediate`、`best_time`、`morning_digest` 三种投递时机
- **Cron / Heartbeat**: 支持定时任务、每日复盘、晨间兜底推送
- **SKILL / skill_tentacle**: 支持从技能直接孵化触手，也支持内置触手自动安装
- **内置触手**: 自带 7 个 builtin tentacles，覆盖 HN、GitHub Release、daily digest、arXiv、价格、uptime、触手生成器

## 快速开始

### 前置要求

- Node.js >= 22.0.0
- npm 或 pnpm

### 1. 安装

```bash
cd /Users/didi/Desktop/CC/openceph_v1.0.0/openceph
npm install
```

### 2. 初始化

```bash
npm run dev -- init
# 或编译后
npm run start -- init
```

这会在 `~/.openceph/` 创建完整的目录结构：

```
~/.openceph/
├── openceph.json      # 主配置文件
├── credentials/       # 凭据存储（权限 700）
├── workspace/        # 工作空间（SOUL.md、AGENTS.md 等）
├── skills/           # 内置/社区 skill_tentacle 安装目录
├── brain/            # Pi 框架数据
├── agents/          # Agent 会话存储
├── tentacles/       # 已孵化的触手运行目录
├── cron/            # Cron 任务与执行记录
├── logs/            # 日志文件
└── state/           # 状态文件
```

首次 `init` 默认会把以下内置触手复制到 `~/.openceph/skills/`：

- `skill-tentacle-creator`
- `hn-radar`
- `github-release-watcher`
- `daily-digest-curator`
- `arxiv-paper-scout`
- `price-alert-monitor`
- `uptime-watchdog`

### 3. 配置 API Key

```bash
# 设置 OpenRouter API Key（推荐，用于访问多种模型）
npm run dev -- credentials set openrouter <YOUR_API_KEY>

# 或从环境变量读取
npm run dev -- credentials set openrouter env:OPENROUTER_API_KEY

# 查看已配置的凭据
npm run dev -- credentials list
```

### 4. 修改配置文件

编辑 `~/.openceph/openceph.json`：

```json5
{
  gateway: {
    port: 18790,
    bind: "loopback",
    auth: { mode: "token" }
  },

  agents: {
    defaults: {
      workspace: "~/.openceph/workspace",
      model: {
        primary: "openrouter/anthropic/claude-opus-4-6",
        fallbacks: []
      },
      models: {
        "openrouter/anthropic/claude-opus-4-6": {
          alias: "Opus",
          params: {
            temperature: 0.4,
            cacheRetention: "short"
          }
        }
      }
    }
  },

  tentacle: {
    ipcSocketPath: "~/.openceph/openceph.sock",
    model: {
      primary: "openrouter/anthropic/claude-opus-4-6",
      fallbacks: []
    },
    models: {
      "openrouter/anthropic/claude-opus-4-6": {
        alias: "TentacleOpus",
        params: {
          temperature: 0.4,
          cacheRetention: "short"
        }
      }
    },
    providers: {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions"
      }
    },
    auth: {
      profiles: {
        "openrouter:tentacle": {
          mode: "api_key",
          apiKey: "from:credentials/openrouter"
        }
      },
      order: { openrouter: ["openrouter:tentacle"] }
    }
  },

  auth: {
    profiles: {
      "openrouter:primary": {
        mode: "api_key",
        apiKey: "from:credentials/openrouter"
      }
    },
    order: { openrouter: ["openrouter:primary"] }
  },

  // 启用的渠道
  channels: {
    telegram: { enabled: false },
    feishu: { enabled: false },
    webchat: { enabled: true }
  },

  builtinTentacles: {
    autoInstallOnInit: true,
    autoUpgradeOnUpdate: true,
    skipList: []
  },

  push: {
    defaultTiming: "best_time",
    preferredWindowStart: "09:00",
    preferredWindowEnd: "10:00",
    fallbackDigestTime: "09:00",
    fallbackDigestTz: "UTC"
  }
}
```

说明：

- `agents.defaults.*` + 顶层 `models/auth` 是大脑 Agent 使用的模型配置
- `tentacle.model` + `tentacle.models` + `tentacle.providers` + `tentacle.auth` 是触手运行时使用的独立模型配置
- 如果你希望触手和大脑用同一个模型，直接把大脑那套 provider / auth / model / params 原样复制到 `tentacle.*` 即可
- 触手会优先读取 `tentacle.*`；如果未配置，才会回退到旧的全局配置
- `chat` 是单独的 CLI 模式，不需要在 `channels` 里配置 `cli`
- `builtinTentacles` 控制 `init` / `upgrade` 时 builtin tentacle 的安装和更新策略
- `push` 控制主动推送的默认窗口、晨报兜底时间和每日限制

### 5. 启动

```bash
# 完整启动（Gateway + Brain + 所有渠道）
npm run dev -- start

# 或仅 CLI 对话（不启动 Gateway，适合开发调试）
npm run dev -- chat
```

如果你已经初始化过旧版本，再同步最新内置触手：

```bash
npm run dev -- upgrade
```

### 6. 使用 CLI 对话

```bash
$ npm run dev -- chat
🐙 Ceph ready. Type /help for commands, /exit to quit.
> 你好
[大脑流式回复...]
> /help
可用命令：
  /new [model] - 创建新会话
  /reset      - 重置会话（同 /new）
  /stop      - 停止当前处理
  /status    - 查看状态
  /whoami    - 查看当前用户
  /model     - 模型管理
  /tentacles - 查看活跃触手
  /help      - 显示帮助
```

### 7. 使用 WebChat

启动后访问 `http://127.0.0.1:18791?token=<YOUR_GATEWAY_TOKEN>`

Token 可通过以下命令获取：
```bash
cat ~/.openceph/credentials/gateway_token
```

### 8. 使用 Telegram 对话

#### 步骤 1: 创建 Telegram Bot

1. 打开 Telegram，搜索 `@BotFather`
2. 发送 `/newbot` 创建新机器人
3. 按提示输入机器人名称和用户名（username）
4. 复制 BotFather 给你的 **Bot Token**

#### 步骤 2: 配置凭据

```bash
# 保存 Bot Token
npm run dev -- credentials set telegram_bot_token <YOUR_BOT_TOKEN>
```

#### 步骤 3: 修改配置文件

编辑 `~/.openceph/openceph.json`，启用 Telegram 渠道：

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "from:credentials/telegram_bot_token",
      dmPolicy: "pairing",  // 新用户需要配对
      streaming: true
    }
  }
}
```

#### 步骤 4: 启动服务

```bash
npm run dev -- start
```

#### 步骤 5: 配对并对话

1. 在 Telegram 中搜索你的机器人用户名并发送消息
2. 机器人会回复一个配对码（如 `ABCD-1234`）
3. 在本地终端审批配对：

```bash
npm run dev -- pairing list          # 查看配对请求
npm run dev -- pairing approve ABCD-1234  # 批准配对
```

4. 审批后，在 Telegram 继续发送消息即可与大脑对话

#### DM 策略说明

| 策略 | 行为 |
|------|------|
| `pairing` | 新用户需要审批（默认） |
| `allowlist` | 只有指定用户可以对话 |
| `open` | 任何人都可以对话 |
| `disabled` | 禁用 Telegram |

---

### 9. 使用飞书对话

#### 步骤 1: 创建飞书应用

1. 访问 [飞书开放平台](https://open.feishu.cn/)
2. 创建企业（如已有则跳过）
3. 创建应用：点击「创建应用」→ 输入应用名称
4. 获取凭证：在应用详情页获取 `App ID` 和 `App Secret`

#### 步骤 2: 配置应用权限

在飞书开放平台应用管理页面：

1. 进入「权限管理」
2. 添加以下权限：
   - `im:message:receive_v1` - 接收消息
   - `im:message:send_as_bot` - 以机器人身份发送消息

3. 发布应用版本

#### 步骤 3: 配置凭据

```bash
npm run dev -- credentials set feishu_app_id <YOUR_APP_ID>
npm run dev -- credentials set feishu_app_secret <YOUR_APP_SECRET>
```

#### 步骤 4: 修改配置文件

编辑 `~/.openceph/openceph.json`：

```json5
{
  channels: {
    feishu: {
      enabled: true,
      appId: "from:credentials/feishu_app_id",
      appSecret: "from:credentials/feishu_app_secret",
      domain: "feishu",  // 或 "lark"（飞书海外版）
      dmPolicy: "pairing"
    }
  }
}
```

#### 步骤 5: 启动服务

```bash
npm run dev -- start
```

#### 步骤 6: 添加应用到群聊或私聊

1. 在飞书中打开与机器人的私聊（需要先在应用管理中「启用应用分发」）
2. 或将应用添加到群聊中

#### 步骤 7: 配对并对话

新用户首次发消息时：

1. 飞书会收到配对码
2. 在终端审批：

```bash
npm run dev -- pairing list
npm run dev -- pairing approve <配对码>
```

3. 审批后即可正常对话

---

### 10. 配对系统说明

当渠道的 `dmPolicy` 设置为 `pairing` 时，新用户首次发送消息会触发配对流程：

```
用户发送消息
       ↓
Bot 回复配对码（格式：XXXX-XXXX）
       ↓
用户在终端运行: openceph pairing approve <CODE>
       ↓
用户再次发送消息 → 大脑回复
```

管理配对请求：

```bash
# 列出所有待审批请求
openceph pairing list

# 批准配对
openceph pairing approve ABCD-1234

# 拒绝配对
openceph pairing reject ABCD-1234

# 撤销已批准用户
openceph pairing revoke telegram tg:123456789
```

## 命令行接口

| 命令 | 说明 |
|------|------|
| `openceph init` | 初始化 OpenCeph |
| `openceph upgrade` | 同步 builtin tentacles 到 `~/.openceph/skills/` |
| `openceph start` | 启动完整服务 |
| `openceph chat` | CLI 对话模式 |
| `openceph credentials set <key> [value]` | 设置凭据 |
| `openceph credentials get <key>` | 获取凭据 |
| `openceph credentials list` | 列出凭据 |
| `openceph credentials delete <key>` | 删除凭据 |
| `openceph pairing list` | 列出配对请求 |
| `openceph pairing approve <code>` | 批准配对 |
| `openceph pairing reject <code>` | 拒绝配对 |
| `openceph cron list/add/edit/remove/run/runs` | 管理 Cron 任务 |
| `openceph tentacle list/start/stop/pause/resume/kill` | 管理触手生命周期 |
| `openceph status` | 查看系统状态 |
| `openceph cost` | 查看成本摘要 |
| `openceph doctor [--fix]` | 运行健康检查 |
| `openceph plugin list/install/uninstall` | 管理扩展渠道插件 |
| `openceph logs [brain\|gateway\|system\|cost] [--tail <n>]` | 查看日志 |

## 配置说明

### 渠道配置

```json5
channels: {
  telegram: {
    enabled: true,
    botToken: "from:credentials/telegram_bot_token",
    dmPolicy: "pairing",  // pairing | allowlist | open | disabled
    streaming: true
  },
  feishu: {
    enabled: true,
    appId: "from:credentials/feishu_app_id",
    appSecret: "from:credentials/feishu_app_secret",
    dmPolicy: "pairing"
  },
  webchat: {
    enabled: true,
    port: 18791,
    auth: { mode: "token" }
  }
}
```

### MCP 配置

```json5
mcp: {
  servers: {
    "web-search": {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-brave-search"]
    }
  },
  webSearch: {
    cacheTtlMinutes: 15
  }
}
```

### Session 配置

```json5
session: {
  dmScope: "main",           // main | per-channel-peer
  mainKey: "main",
  reset: {
    mode: "daily",          // daily | idle
    atHour: 4,              // 每日重置时间（UTC）
    idleMinutes: 120        // 空闲超时时间
  }
}
```

### Builtin Tentacles 配置

```json5
builtinTentacles: {
  autoInstallOnInit: true,
  autoUpgradeOnUpdate: true,
  skipList: ["price-alert-monitor"]  // 可选：跳过某些内置触手
}
```

### Push 配置

```json5
push: {
  defaultTiming: "best_time",     // immediate | best_time | morning_digest
  preferredWindowStart: "09:00",
  preferredWindowEnd: "10:00",
  maxDailyPushes: 5,
  consolidate: true,
  fallbackDigestTime: "09:00",
  fallbackDigestTz: "UTC"
}
```

## 内置触手

`openceph init` 后会自动安装以下 7 个 builtin tentacles：

| 名称 | 用途 |
|------|------|
| `skill-tentacle-creator` | 生成新的可运行 skill_tentacle 脚手架并做本地校验/打包 |
| `hn-radar` | 监控 Hacker News，支持 RSS + Algolia、规则过滤、可选 LLM 过滤 |
| `github-release-watcher` | 跟踪 GitHub Release / Tag 更新 |
| `daily-digest-curator` | 从 state 中的待推送/待处理内容生成每日简报 |
| `arxiv-paper-scout` | 监控 arXiv 分类与关键词，并可用 LLM 进行质量判断 |
| `price-alert-monitor` | 监控价格变化，支持 `json_path` / `selector` / `pattern` 抽取 |
| `uptime-watchdog` | 监控 HTTP 端点可用性、恢复和慢响应 |

这些触手的源代码位于仓库的 `builtin-tentacles/`，运行副本位于 `~/.openceph/skills/` 和 `~/.openceph/tentacles/`。

## 主动推送链路

当前版本已经实现完整的触手推送协议：

1. 触手通过 IPC 向 Brain 发起 consultation request
2. Brain 在 consultation / cron session 中决定是否调用 `send_to_user`
3. `immediate` 推送会立刻投递到渠道，并把推送内容写入主 session
4. `best_time` / `morning_digest` 会进入统一出站队列，随后在用户活跃窗口或晨间兜底任务中投递
5. 连续 assistant 推送在发给模型前会由 `push-message-merger` 进行运行时合并

因此，用户后续回复一条推送内容时，大脑可以在主 session 上下文里自然理解这条回复。

## 凭据系统

支持多种凭据来源：

| 格式 | 说明 |
|------|------|
| `from:credentials/<name>` | 从 `~/.openceph/credentials/<name>` 文件读取 |
| `from:credentials/<dir>/<name>` | 从 `~/.openceph/credentials/<dir>/<name>` 读取 |
| `env:<VAR_NAME>` | 从环境变量读取 |
| `keychain:<service>:<key>` | 从 macOS Keychain 读取 |

## Workspace 文件

`~/.openceph/workspace/` 目录包含定义大脑行为的文件：

| 文件 | 用途 |
|------|------|
| `SOUL.md` | 大脑的核心价值观和行为准则 |
| `AGENTS.md` | Agent 的具体行为规范 |
| `IDENTITY.md` | 身份定义 |
| `USER.md` | 用户信息 |
| `TOOLS.md` | 可用工具说明 |
| `HEARTBEAT.md` | 主动推送行为规则 |
| `TENTACLES.md` | 触手配置 |
| `MEMORY.md` | 长期记忆 |
| `BOOTSTRAP.md` | 首次运行引导 |

## 日志

日志位于 `~/.openceph/logs/`：

| 文件 | 内容 |
|------|------|
| `brain.log` | Brain 对话日志 |
| `gateway.log` | Gateway 消息路由日志 |
| `system.log` | 系统事件日志 |
| `cost.log` | API 调用成本日志 |
| `cache-trace.jsonl` | Prompt Cache 命中记录 |

## 开发

```bash
# 开发模式（热重载）
npm run dev

# 编译
npm run build

# 运行测试
npm test

# TypeScript 编译检查
npm run build

# Python 内置触手语法检查
python3 -m py_compile builtin-tentacles/*/src/*.py
```

## 目录结构

```
src/
├── cli.ts                    # CLI 入口
├── main.ts                   # 完整启动流程
├── config/                   # 配置系统
│   ├── config-loader.ts
│   ├── config-schema.ts
│   └── credential-store.ts
├── pi/                       # Pi 框架封装
│   ├── pi-context.ts
│   ├── pi-auth.ts
│   ├── pi-models.ts
│   └── pi-session.ts
├── brain/                    # Brain 核心
│   ├── brain.ts
│   ├── system-prompt.ts
│   ├── context-assembler.ts
│   └── extensions/           # Pi 扩展
├── memory/                   # 记忆系统
├── gateway/                  # 网关
│   ├── gateway.ts
│   ├── router.ts
│   ├── session-manager.ts
│   ├── message-queue.ts
│   ├── pairing.ts
│   ├── session-reset.ts
│   ├── auth/                # 认证系统
│   ├── adapters/           # 渠道适配器
│   │   ├── telegram/
│   │   ├── feishu/
│   │   ├── webchat/
│   │   └── cli/
│   └── commands/           # 命令处理
├── tools/                   # 工具系统
├── push/                    # 推送决策 / 出站队列 / 反馈跟踪
├── tentacle/                # 触手生命周期 / IPC / review
├── skills/                  # SkillLoader / SkillSpawner / Packager
├── cron/                    # 定时任务
├── heartbeat/               # 心跳调度
├── session/                 # transcript 存储
├── builtin-tentacles/       # 内置 skill_tentacle
└── mcp/                     # MCP 桥接
```

## 自定义模型配置

默认内置了 `anthropic/claude-sonnet-4-5`、`anthropic/claude-opus-4-5`、`openai/gpt-4o` 三个 OpenRouter 模型。如果需要使用其他模型（如 `claude-opus-4-6`、`gemini` 等），需要在 `openceph.json` 的 `models.providers` 中显式声明：

```json5
{
  models: {
    providers: {
      openrouter: {
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-completions",
        // 在这里添加自定义模型
        models: [
          {
            id: "anthropic/claude-opus-4-6",
            name: "Claude Opus 4.6",
            reasoning: true,
            input: ["text", "image"],
            cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 0 },
            contextWindow: 1000000,
            maxTokens: 128000
          }
        ]
      }
    }
  },

  agents: {
    defaults: {
      model: {
        primary: "openrouter/anthropic/claude-opus-4-6"
      }
    }
  },

  auth: {
    profiles: {
      "openrouter:primary": {
        mode: "api_key",
        apiKey: "from:credentials/openrouter"
      }
    },
    order: { openrouter: ["openrouter:primary"] }
  }
}
```

自定义模型会与内置默认模型合并，相同 `id` 的自定义模型会覆盖默认值。

---

## 代理（Proxy）配置

### 为什么需要代理

OpenRouter 对部分地区有访问限制。常见症状：

- `curl` 调用 OpenRouter 正常（因为 shell 会自动走 `HTTP_PROXY`）
- 但 OpenCeph 启动后报 `403 This model is not available in your region.`

这是因为 Node.js 的 `fetch` **默认不读取** `HTTP_PROXY` 环境变量。OpenCeph 已内置了代理支持（通过 undici 的 `EnvHttpProxyAgent`），但需要确保启动时环境变量存在。

### 配置方法

在启动 OpenCeph 的终端中确保设置了代理环境变量：

```bash
export HTTP_PROXY=http://127.0.0.1:7897
export HTTPS_PROXY=http://127.0.0.1:7897
```

建议将上述内容写入 `~/.bashrc` 或 `~/.zshrc`，避免每次手动设置。

启动后如果代理生效，终端会显示：

```
🌐 Proxy enabled: http://127.0.0.1:7897
```

### 验证代理是否工作

```bash
# 1. 先用 curl 验证 OpenRouter 可达
curl -sS https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $(cat ~/.openceph/credentials/openrouter)" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4-5","messages":[{"role":"user","content":"Reply OK"}]}'

# 2. 再启动 OpenCeph 验证完整链路
npm run dev -- start
```

如果 curl 成功但 OpenCeph 仍报 403，检查：
1. 启动 OpenCeph 的终端是否设置了 `HTTP_PROXY` / `HTTPS_PROXY`
2. 代理服务（如 ClashX）是否正在运行

---

## 常见问题排查

### 启动时端口被占用（EADDRINUSE）

```
Error: listen EADDRINUSE: address already in use 127.0.0.1:18791
```

上次启动的进程没有正确退出。解决：

```bash
# 杀掉占用端口的进程
lsof -ti :18791 | xargs kill -9
lsof -ti :18790 | xargs kill -9

# 重新启动
npm run dev -- start
```

### 飞书发消息后无任何回复

检查日志 `~/.openceph/logs/gateway-<日期>.log`，常见原因：

| 日志中的错误 | 原因 | 解决方案 |
|---|---|---|
| `Model not found: openrouter/xxx` | 模型未在 `models.providers` 中注册 | 在配置文件中添加自定义模型（见上方「自定义模型配置」） |
| `403 This model is not available in your region` | Node.js 请求未走代理 | 设置 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量（见上方「代理配置」） |
| `pairing_request` | 用户尚未完成配对 | 运行 `npm run dev -- pairing approve <配对码>` |

### 查看日志的快捷命令

```bash
# 查看最近的 gateway 日志（消息路由、错误）
tail -50 ~/.openceph/logs/gateway-$(date +%F).log

# 查看最近的 brain 日志（模型调用）
tail -50 ~/.openceph/logs/brain-$(date +%F).log

# 查看会话 transcript（包含完整的 API 请求/响应）
ls ~/.openceph/agents/ceph/sessions/
cat ~/.openceph/agents/ceph/sessions/<SESSION_ID>.jsonl
```

---

## 未来规划 (Phase 2+)

- **触手系统 (Tentacles)**: 大脑的主动执行能力
- **Heartbeat**: 定时主动推送
- **语义记忆检索**: 升级记忆系统为向量检索
- **多大脑支持**: 支持多个 Brain Agent

## 相关文档

- [PRD v3](/Users/didi/Desktop/CC/openceph_v1.0.0/prd/openceph_prd_v3.md)
- [Phase 1 需求](/Users/didi/Desktop/CC/openceph_v1.0.0/prd/phase1.md)
- [Phase 2 需求](/Users/didi/Desktop/CC/openceph_v1.0.0/prd/phase2.md)
