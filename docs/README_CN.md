# OpenCeph — 主动式 AI 个人操作系统

<p align="center">
    <img src="../assets/logo.png" alt="OpenCeph" width="300">
</p>

<p align="center">
  <strong>你的第一个真正的个人Agent组织。不是更好的信息工具——而是一个替你工作的组织。</strong>
</p>

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/Release-v2026.4.1-orange?style=for-the-badge" alt="v2026.4.1"></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="../README.md"><img src="https://img.shields.io/badge/English-README-green?style=for-the-badge" alt="English"></a>
</p>

**OpenCeph** 是一个运行在你自己设备上的 _主动式 AI 个人操作系统_。不同于传统的 AI 助手等着你来问，OpenCeph **自主运行** ——通过触手（Tentacle）系统持续监控、分析和汇报。它接入你已经在用的通讯渠道（Telegram、飞书、WebChat、CLI），记住所有事情，只在真正重要的时候才打扰你。

换个方式理解：你雇了一批员工，他们知道自己的职责，各司其职，只在有重要事项时向你汇报。

## 核心亮点

- **主动而非被动** — 触手 7x24 小时运行，持续监控、分析和过滤。你收到的是推送通知，而不是需要主动查询。
- **多渠道网关** — Telegram、飞书、WebChat、CLI。一个大脑，覆盖你已经在用的所有平台。
- **自主触手系统** — 独立的 Agent 子进程，三层架构：守护层（数据抓取）、Agent 层（LLM 分析）、咨询层（Brain 审查）。
- **长期记忆** — 基于 MEMORY.md 的持久化知识库，每日日志，SQLite FTS5 语义搜索。
- **心跳与定时任务** — 调度任务和主动推送，智能去重、优先级排序、时区感知投递。
- **技能系统** — 放入 Python/TypeScript/Go/Shell 技能即可自动部署为触手。内置 7 个触手。
- **Pi 框架核心** — 基于 @mariozechner/pi-agent-core 构建，支持工具流式调用、上下文压缩和模型故障转移。
- **MCP 桥接** — 连接任意 MCP 服务器，扩展 Brain 的工具能力。
- **工作区文件** — 8 个可编辑的 Markdown 文件（SOUL、AGENTS、IDENTITY、USER、TOOLS、HEARTBEAT、TENTACLES、MEMORY）定义你的 Agent 的人格、规则和知识。

## 安装

运行环境要求：**Node >= 22**

```bash
npm install
npm run build

# 初始化 ~/.openceph/ 目录结构
npm start -- init
```

## 快速开始

```bash
# 1. 初始化（仅首次需要）
npx tsx src/cli.ts init

# 2. 设置 API 凭证
npx tsx src/cli.ts credentials set openrouter <你的API密钥>

# 3. 启动完整系统（网关 + Brain + 所有渠道）
npx tsx src/cli.ts start

# 或者：仅 CLI 聊天模式（无网关、无渠道）
npx tsx src/cli.ts chat
```

开发模式（自动重载）：

```bash
npm run dev -- start
```

### 代理配置（解决区域限制 / IP 被拦截）

如果你在中国大陆或其他受限网络环境下运行，访问 OpenRouter 等海外 API 时可能遇到 `403 This model is not available in your region` 错误。需要配置 HTTP 代理：

```bash
# 方式 1：运行时临时指定（推荐）
HTTPS_PROXY=http://127.0.0.1:7890 npx tsx src/cli.ts chat

# 方式 2：当前终端会话设置
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
npx tsx src/cli.ts chat

# 方式 3：写入 shell 配置永久生效
echo 'export HTTPS_PROXY=http://127.0.0.1:7890' >> ~/.zshrc
echo 'export HTTP_PROXY=http://127.0.0.1:7890' >> ~/.zshrc
source ~/.zshrc
```

> 将 `127.0.0.1:7890` 替换为你本机代理的实际地址和端口（Clash 默认 7890，V2Ray 常用 1080 等）。

OpenCeph 使用 Node.js `undici` 的 `EnvHttpProxyAgent` 全局代理，支持以下环境变量（按优先级）：
`HTTPS_PROXY` > `https_proxy` > `HTTP_PROXY` > `http_proxy` > `ALL_PROXY` > `all_proxy`

### 停止 / 重启

```bash
# 停止所有 OpenCeph 进程
pkill -9 -f "cli.ts start"

# 重启
pkill -9 -f "cli.ts start" && sleep 2 && npx tsx src/cli.ts start

# 完整重新初始化（备份 → 初始化 → 恢复配置 → 启动）
mv ~/.openceph ~/.openceph_backup_$(date +%Y%m%d_%H%M%S)
npx tsx src/cli.ts init
cp ~/.openceph_backup_*/openceph.json ~/.openceph/openceph.json
cp ~/.openceph_backup_*/credentials/* ~/.openceph/credentials/
npx tsx src/cli.ts upgrade
npx tsx src/cli.ts start
```

## 架构概览

```
Telegram / 飞书 / WebChat / CLI
               |
               v
+-------------------------------+
|            网关 Gateway         |
|     (消息路由层)                 |
|     ws://127.0.0.1:18790       |
+---------------+---------------+
                |
                +-- Brain Agent (Pi 框架)
                |    +-- 系统提示词 (SOUL.md + AGENTS.md + 上下文)
                |    +-- 工具执行 (16+ 工具类型)
                |    +-- 记忆系统 (MEMORY.md + FTS5 搜索)
                |    +-- 模型故障转移 (Anthropic / OpenAI / OpenRouter)
                |
                +-- 触手管理器
                |    +-- 触手 1 (hn-radar)
                |    +-- 触手 2 (arxiv-paper-scout)
                |    +-- 触手 3 (github-release-watcher)
                |    +-- 触手 N ... (用户自建)
                |
                +-- 心跳调度器 (主动推送)
                +-- 定时任务调度器
                +-- 推送决策引擎 (去重 + 优先级 + 投递)
```

## 核心子系统

### Brain（大脑）

基于 Pi 框架构建的中央智能。处理所有用户交互、工具执行和触手协调。系统提示词从 8 个工作区文件动态组装。支持 Anthropic Claude、OpenAI 以及通过 OpenRouter 接入的 2000+ 模型。包含提示词缓存、上下文压缩（4 层防御）、循环检测和自动模型故障转移。

**消息流**: 渠道 -> 网关路由 -> `Brain.handleMessage()` -> 工具执行 -> 响应 -> 渠道 -> 用户

### Gateway（网关）

多渠道消息路由层。适配器覆盖 Telegram (grammy)、飞书 (Lark SDK)、WebChat (Express + ws) 和 CLI (readline)。处理会话配对、DM 访问控制（配对/白名单/开放/禁用）、输入指示器和流式传输。插件架构支持扩展渠道。

### 触手系统

自主 Agent 子进程 —— 章鱼的触手。每个触手都是独立进程，通过 stdin/stdout JSON-Lines IPC 与 Brain 通信。

**三层架构**：
- **第一层 — 守护层**: 纯代码，无 LLM。持续数据抓取、规则过滤、累积。
- **第二层 — Agent 层**: 基于 LLM 的分析，当累积项达到批处理阈值时触发。
- **第三层 — 咨询层**: 不确定发现（置信度 0.4-0.8）时与 Brain 进行多轮对话。

**IPC 协议**: `tentacle_register` -> `report_finding` / `consultation_request` -> `directive` (暂停/恢复/终止)

**健康评分**: 基于汇报质量自动强化/弱化。低健康度的触手会被终止。

**内置触手**:

| 触手 | 状态 | 描述 |
|------|------|------|
| `hn-radar` | 已发布 | Hacker News 监控，LLM 过滤 |
| `arxiv-paper-scout` | 开发中 | ArXiv 论文追踪，按研究兴趣 |
| `github-release-watcher` | 开发中 | GitHub Release 监控 |
| `daily-digest-curator` | 开发中 | 每日摘要生成与投递 |
| `price-alert-monitor` | 开发中 | 价格变动检测与提醒 |
| `uptime-watchdog` | 开发中 | 服务可用性监控 |
| `skill-tentacle-creator` | 开发中 | 创建新触手的脚手架工具 |

### 记忆系统

长期知识持久化。`MEMORY.md` 是中央知识库（用户可编辑）。每日日志存储在 `~/.openceph/workspace/memory/YYYY-MM-DD.md`。SQLite FTS5 全文搜索用于语义检索。记忆蒸馏由心跳触发。

### 心跳与定时任务

**心跳**: 主动推送机制。可配置频率（如每 24 小时）。Brain 在隔离的心跳会话中评估"该推送什么"。支持 `immediate`（即时）、`best_time`（延迟到早间窗口）和 `morning_digest`（批量每日摘要）投递模式。

**定时任务**: 调度任务管理。支持 cron 表达式、固定间隔和指定时间。任务在主会话模式（队列事件）或隔离会话（运行 AI 回合）中运行。包含维护任务：`daily-review`（反思）和 `morning-digest-fallback`（延迟推送投递）。

### 推送决策引擎

智能消息投递。去重（URL + 相似度检测）。优先级：紧急、高、普通、低。每日推送限额。反馈追踪监控用户反应，调整未来推送质量。

### 技能系统

动态能力扩展。扫描 `~/.openceph/skills/` 查找技能蓝图。将 SKILL.md 定义转化为独立触手。支持 Python、TypeScript、Go 和 Shell 运行时。Claude Code 集成用于代码生成和部署。

## 聊天命令

在 Telegram / 飞书 / WebChat 中发送：

| 命令 | 描述 |
|------|------|
| `/new` | 重置当前会话 |
| `/model <名称>` | 切换活跃模型 |
| `/think <级别>` | 设置推理级别 |
| `/help` | 显示可用命令 |
| `/status` | 显示会话状态 |
| `/tentacles` | 列出活跃触手 |
| `/skill` | 列出 / 启动技能 |
| `/pause` | 暂停当前触手 |
| `/resume` | 恢复暂停的触手 |
| `/cost` | 显示使用费用摘要 |

## 配置

最简 `~/.openceph/openceph.json`：

```json5
{
  brain: {
    model: "openrouter/anthropic/claude-sonnet-4-6",
  },
}
```

完整配置使用 JSON5 格式，Zod schema 校验。100+ 可配置选项，涵盖模型选择、渠道设置、触手默认值、定时任务、心跳频率、推送限额等。

### 凭证管理

```bash
# 设置 API 密钥
npx tsx src/cli.ts credentials set openrouter <KEY>
npx tsx src/cli.ts credentials set anthropic <KEY>

# 或使用环境变量
export OPENROUTER_API_KEY=sk-...

# 或 macOS 钥匙串
# credentials: "keychain:openceph-openrouter"
```

凭证存储在 `~/.openceph/credentials/`，文件权限 600。

### 渠道配置

#### Telegram

```json5
{
  channels: {
    telegram: {
      botToken: "123456:ABCDEF",
      // allowFrom: ["user_id_1", "user_id_2"],
      // dmPolicy: "pairing",
    },
  },
}
```

#### 飞书

```json5
{
  channels: {
    feishu: {
      appId: "cli_xxx",
      appSecret: "xxx",
      // encryptKey: "xxx",
      // verificationToken: "xxx",
    },
  },
}
```

#### WebChat

```json5
{
  channels: {
    webchat: {
      enabled: true,
      // port: 18790,
    },
  },
}
```

#### CLI

开发模式下默认启用：

```bash
npx tsx src/cli.ts chat
```

## 安全默认值（DM 访问控制）

OpenCeph 接入真实的即时通讯平台。将入站 DM 视为 **不可信输入**。

- **DM 配对** (`dmPolicy="pairing"`): 未知发送者收到一个短配对码，Bot 不处理其消息。
- 通过以下命令审批: `npx tsx src/cli.ts pairing approve <channel> <code>`
- 公开入站 DM 需要显式开启: 设置 `dmPolicy="open"`。
- **凭证隔离**: API 密钥存储在 `~/.openceph/credentials/`，文件权限 600。
- **认证 Profile**: 按提供商的凭证轮换，自动故障转移。
- **触手沙箱**: 触手仅通过 IPC 通信，不能直接联系用户，文件写入限制在其工作区内。

## Agent 工作区与技能

工作区根目录: `~/.openceph/workspace/`

| 文件 | 用途 |
|------|------|
| `SOUL.md` | 人格、价值观、行为边界 |
| `AGENTS.md` | 操作流程（记忆规则、触手管理、推送规则） |
| `IDENTITY.md` | 公开身份元数据（名称、ID、emoji、版本） |
| `USER.md` | 用户画像（姓名、项目、兴趣、沟通偏好） |
| `TOOLS.md` | 自然语言工具文档 |
| `HEARTBEAT.md` | 主动推送的每日检查清单 |
| `TENTACLES.md` | 触手注册表及状态追踪 |
| `MEMORY.md` | 精炼后的长期记忆 |

所有文件都是用户可编辑的 Markdown。Brain 的系统提示词在运行时从这些文件动态组装。技能存放在 `~/.openceph/skills/<skill>/SKILL.md`。

## CLI 参考

| 命令 | 描述 |
|------|------|
| `npx tsx src/cli.ts init` | 初始化 `~/.openceph/` 目录结构 |
| `npx tsx src/cli.ts start` | 启动完整系统（网关 + Brain + 渠道） |
| `npx tsx src/cli.ts chat` | 仅 CLI 聊天模式（无网关） |
| `npx tsx src/cli.ts upgrade` | 同步内置触手到 `~/.openceph/skills/` |
| `npx tsx src/cli.ts credentials set <provider> <key>` | 存储 API 凭证 |
| `npx tsx src/cli.ts credentials list` | 列出已配置的凭证 |
| `npx tsx src/cli.ts cron list\|add\|edit\|remove` | 管理定时任务 |
| `npx tsx src/cli.ts logs [type]` | 查看系统日志 |
| `npx tsx src/cli.ts status` | 显示系统状态 |
| `npx tsx src/cli.ts cost` | 显示使用费用摘要 |
| `npx tsx src/cli.ts doctor` | 运行系统诊断 |

## 运行时目录结构

```
~/.openceph/
+-- openceph.json           # 主配置文件 (JSON5)
+-- credentials/            # API 密钥和 Token (权限 700)
+-- workspace/              # 用户可编辑的知识库
|   +-- SOUL.md
|   +-- AGENTS.md
|   +-- IDENTITY.md
|   +-- USER.md
|   +-- TOOLS.md
|   +-- HEARTBEAT.md
|   +-- TENTACLES.md
|   +-- MEMORY.md
|   +-- memory/             # 每日记忆日志 (YYYY-MM-DD.md)
+-- brain/                  # Pi 框架 Agent 状态
+-- agents/                 # Agent 实例
|   +-- ceph/              # 主 Brain (会话、日志)
|   +-- code-agent/        # 代码生成 Agent
|   +-- gateway/           # 网关事件日志
+-- tentacles/              # 已启动的触手实例
|   +-- <tentacle-id>/    # 单个触手的状态 + 日志
+-- skills/                 # 技能/触手模板
|   +-- hn-radar/
|   +-- arxiv-paper-scout/
|   +-- ...
+-- cron/                   # 定时任务定义 + 运行历史
+-- logs/                   # 系统级日志 (费用、缓存追踪)
+-- state/                  # 运行时状态 (配对、队列、PID 文件)
+-- contracts/              # IPC 契约 schema
```

## 技术栈

| 类别 | 技术 |
|------|------|
| 运行时 | Node.js 22+ |
| 语言 | TypeScript 5.9 |
| AI 框架 | Pi Framework (pi-agent-core 0.60) |
| LLM 提供商 | Anthropic, OpenAI, OpenRouter (2000+ 模型) |
| HTTP 服务器 | Express 5 |
| WebSocket | ws 8.x |
| Telegram | grammy |
| 飞书 | @larksuiteoapi/node-sdk |
| 调度 | node-cron |
| 配置 | JSON5 + Zod 4 校验 |
| 日志 | Winston + daily-rotate-file |
| 记忆搜索 | SQLite FTS5 |
| CLI | Commander.js |
| 测试 | Vitest |

## 适用人群

OpenCeph 为那些需要 **持续监控事物** 或有 **后台任务需要执行** 的人而构建——这些任务需要判断力（无法纯脚本化），但又太重复或太耗时以至于无法手动完成。

- **AI 研究者** — 自动实验追踪、自适应策略调整
- **独立开发者** — 竞品监控、用户信号发现、新模型 API 测试
- **AI 创始人** — 竞争雷达、投资人动态追踪、社区情绪
- **开源维护者** — Issue 优先级、依赖安全、PR 进度追踪
- **量化交易者** — 24h 市场异常检测、自动化提醒策略
- **数据科学家** — 数据质量监控、模型漂移检测、重训练触发
- **AI 产品经理** — 真实用户反馈聚合、竞品功能变化

## 社区

欢迎贡献! 查看 [CONTRIBUTING.md](../CONTRIBUTING.md) 了解贡献指南。

## 许可证

[MIT](../LICENSE)
