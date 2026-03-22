# skill_tentacle 开发指南

## 概述

skill_tentacle 是 OpenCeph 的标准化触手打包格式。社区开发者打包一次，所有用户直接部署。

## 目录结构

```
{tentacle-name}/
├── SKILL.md                # 必需：Pi 兼容的 frontmatter + 触手描述
├── README.md               # 必需：部署指南（Claude Code 读取并执行）
├── prompt/
│   ├── SYSTEM.md           # 必需：触手系统提示词
│   ├── AGENTS.md           # 可选：行为规则
│   └── TOOLS.md            # 可选：工具描述
├── src/
│   ├── main.py             # 必需：主进程入口
│   ├── ipc_client.py       # 推荐：标准 IPC 客户端
│   ├── ...                 # 其他业务代码
│   └── requirements.txt    # 必需：依赖列表
└── docs/                   # 可选：参考文档
```

## SKILL.md Frontmatter 规范

```yaml
---
name: my-tentacle
description: 一句话描述触手功能
version: 1.0.0
trigger_keywords:
  - keyword1
  - keyword2
metadata:
  openceph:
    emoji: 🔍
    trigger_keywords:
      - 触发词1
      - 触发词2
    tentacle:
      spawnable: true                    # 必需：标记为可部署
      runtime: python                    # python | typescript | go | shell
      entry: src/main.py                 # 入口文件
      default_trigger: self              # self | external
      setup_commands:                    # 部署时执行的命令
        - pip install -r src/requirements.txt
      requires:
        bins:                            # 需要的系统命令
          - python3
        env:                             # 需要的环境变量
          - MY_API_KEY
      capabilities:                      # 触手能力标签
        - web_fetch
        - data_filter
      infrastructure:                    # 基础设施需求
        needsLlm: false
        needsDatabase: false
        needsHttpServer: false
        needsExternalBot: false
      customizable:                      # 可定制字段
        - field: my_setting
          description: 设置描述
          env_var: MY_SETTING            # 注入到 .env
          default: "default_value"
          example: "example_value"
        - field: user_name
          description: 用户名称
          prompt_placeholder: "{USER_NAME}"  # 替换 SYSTEM.md 中的占位符
          default: "用户"
---

# my-tentacle

详细描述...
```

### 关键字段说明

| 字段 | 必需 | 说明 |
|------|------|------|
| `spawnable: true` | 是 | 标记为可部署的 skill_tentacle |
| `runtime` | 是 | 运行时：python / typescript / go / shell |
| `entry` | 是 | 入口文件路径 |
| `default_trigger` | 是 | 默认触发模式：self（自管循环）/ external（等待外部触发） |
| `setup_commands` | 是 | 部署时执行的初始化命令 |
| `requires.bins` | 否 | 需要预安装的系统命令 |
| `requires.env` | 否 | 需要用户提供的环境变量 |
| `customizable` | 否 | 用户可定制的配置字段 |

### Customizable 字段类型

1. **env_var 注入**：值写入 `.env` 文件
   ```yaml
   - field: api_key
     description: API 密钥
     env_var: MY_API_KEY
   ```

2. **prompt_placeholder 注入**：替换 SYSTEM.md 中的 `{PLACEHOLDER}` 占位符
   ```yaml
   - field: user_name
     prompt_placeholder: "{USER_NAME}"
     default: "用户"
   ```

## README.md 编写规范

README.md 是 Claude Code 部署时的指南，必须包含：

1. **概述**（一句话）
2. **环境要求**（Python/Node 版本）
3. **环境变量表**
4. **部署步骤**（精确的 bash 命令）
5. **启动命令**
6. **常见问题**
7. **个性化指南**

示例：

```markdown
# GitHub Issue Radar

监控指定 GitHub 仓库的新 issue 和 PR。

## 环境要求
- Python 3.10+

## 环境变量
| 变量 | 必需 | 说明 |
|------|------|------|
| GITHUB_TOKEN | 是 | GitHub Personal Access Token |
| GITHUB_REPOS | 是 | 监控的仓库列表（逗号分隔） |

## 部署步骤
```bash
cd {TENTACLE_DIR}
python3 -m venv venv
source venv/bin/activate
pip install -r src/requirements.txt
```

## 启动命令
```bash
python3 src/main.py
```
```

## prompt/SYSTEM.md 编写规范

```markdown
# Identity
你是 GitHub Issue Radar 触手。

# Mission
监控指定仓库的 issue 和 PR，筛选 {USER_NAME} 关心的技术话题。

# User Context
- 用户名称：{USER_NAME}
- 技术关注：{USER_TECHNICAL_FOCUS}

# Judgment Criteria
- 重要：与用户关注领域直接相关的 issue
- 一般：技术讨论、feature request
- 忽略：bot 生成的、重复的

# Report Strategy
- 每个周期批量上报一次
- 重要发现立即标记
- 噪音直接丢弃

# Report Format
标题：[仓库名] issue 标题
链接：URL
摘要：一句话概括
判断：important / reference / discard

# Constraints
- 不生成代码
- 不修改任何文件
- API 调用遵循 rate limit
```

## IPC 三条契约

所有 skill_tentacle 必须实现：

### 契约 1：启动注册

连接到 `OPENCEPH_SOCKET_PATH` 后立即发送：

```json
{
  "type": "tentacle_register",
  "sender": "<tentacle_id>",
  "receiver": "brain",
  "payload": {
    "tentacle_id": "<tentacle_id>",
    "purpose": "触手使命",
    "runtime": "python",
    "pid": 12345
  },
  "timestamp": "2024-01-01T00:00:00.000Z",
  "message_id": "uuid"
}
```

### 契约 2：批量上报

通过 `consultation_request` 上报发现：

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
        "content": "发现内容",
        "reason": "筛选理由",
        "tentacleJudgment": "important"
      }
    ],
    "summary": "本次扫描概要"
  },
  "timestamp": "2024-01-01T00:00:00.000Z",
  "message_id": "uuid"
}
```

### 契约 3：接收指令

处理来自大脑的 `directive` 消息：

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

## 触发模式

读取 `OPENCEPH_TRIGGER_MODE` 环境变量：

- **self**：内部定时循环（读取 CHECK_INTERVAL 等配置）
- **external**：等待 `run_now` 指令触发

```python
trigger_mode = os.environ.get("OPENCEPH_TRIGGER_MODE", "self")
if trigger_mode == "self":
    while running:
        do_scan()
        time.sleep(interval_seconds)
else:
    # 等待 run_now 指令
    while running:
        time.sleep(1)
```

## Python IPC 客户端

推荐直接复用 OpenCeph 提供的标准 IPC 客户端：

```python
from ipc_client import IpcClient

client = IpcClient(socket_path, tentacle_id)
client.connect()
client.register(purpose="监控 GitHub Issues", runtime="python")

# 上报
client.consultation_request(
    mode="batch",
    items=[{"id": "1", "content": "...", "tentacleJudgment": "important"}],
    summary="发现 3 个重要 issue"
)

# 处理指令
def handle_directive(payload):
    action = payload.get("action")
    if action == "kill":
        sys.exit(0)

client.on_directive(handle_directive)
```

## --dry-run 支持（推荐）

实现 `--dry-run` 参数，验证配置和 API 连通性但不启动主循环：

```python
if "--dry-run" in sys.argv:
    print("Config OK")
    print(f"Repos: {repos}")
    print(f"API connection: OK")
    sys.exit(0)
```

## 打包与分发

### 打包已部署的触手

```bash
openceph tentacle pack <tentacle_id>
# 输出: ~/.openceph/packages/<tentacle_id>.tentacle
```

### 安装 skill_tentacle

```bash
# 从 .tentacle 文件
openceph tentacle install ./my-tentacle.tentacle

# 从 GitHub
openceph tentacle install github:user/repo/skills/my-tentacle

# 从本地目录
openceph tentacle install ./path/to/skill-tentacle/
```

### 列出已安装

```bash
openceph tentacle list
```

### 查看详情

```bash
openceph tentacle info my-tentacle
```

### 验证

```bash
openceph tentacle validate ./path/to/skill-tentacle/
```

## 验证规则

skill_tentacle 在部署前会通过 4 项验证：

1. **Structure**：目录结构完整性（SKILL.md, README.md, prompt/SYSTEM.md, src/）
2. **Syntax**：代码语法正确性（Python: py_compile, TS: tsc --noEmit）
3. **Contract**：IPC 三契约合规性（tentacle_register, consultation_request, directive 处理）
4. **Security**：安全黑名单检查（禁止 exec/eval/os.system 等）

## 示例 skill_tentacle

OpenCeph 内置 3 个示例：

1. **github-issue-radar** — 监控 GitHub 仓库 issue/PR（Scene 1 参考实现）
2. **hn-engineering-digest** — HN 工程热帖摘要（Scene 2 产物）
3. **content-creator-assistant** — 内容创作助手（复杂 Agent 系统）

查看源码：`~/.openceph/skills/` 或项目 `src/templates/skills/`

## 开发流程

1. 创建目录结构
2. 编写 SKILL.md（frontmatter 必须包含 `spawnable: true`）
3. 编写 README.md（Claude Code 部署指南）
4. 编写 prompt/SYSTEM.md（带 `{PLACEHOLDER}` 占位符）
5. 实现 src/main.py（IPC 三契约 + 触发模式）
6. 验证：`openceph tentacle validate ./my-tentacle/`
7. 测试：`python3 src/main.py --dry-run`
8. 打包：`openceph tentacle pack <id>` 或直接分享目录
