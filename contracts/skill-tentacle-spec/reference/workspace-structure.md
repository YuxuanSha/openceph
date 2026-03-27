# Workspace 目录结构完整规范

**文件位置：** `contracts/skill-tentacle-spec/reference/workspace-structure.md`  
**用途：** 触手运行时目录结构的完整定义

---

## 1. 触手根目录

每个触手部署在 `~/.openceph/tentacles/{tentacle_id}/` 下：

```
~/.openceph/tentacles/{tentacle_id}/
│
├── tentacle.json               # [必须] 触手元数据（运行时状态、配置快照）
├── .env                        # [必须] 环境变量（部署时自动生成）
│
├── src/                        # [必须] 工程源代码
│   ├── main.py                 # 入口文件
│   ├── requirements.txt        # 依赖
│   └── ...                     # 其他源文件
│
├── prompt/                     # [必须] Agent prompt 原始文件
│   └── SYSTEM.md               # 触手 system prompt（含占位符的原始版）
│
├── tools/                      # [如有自建工具] 工具定义
│   └── tools.json
│
├── workspace/                  # [必须] 触手工作空间（Agent 读写）
│   ├── SYSTEM.md               # system prompt 填充版（运行时使用此文件）
│   ├── STATUS.md               # 运行状态（触手自维护）
│   └── REPORTS.md              # 历史汇报摘要（触手自维护）
│
├── data/                       # [推荐] 工程层持久化数据
│   ├── state.db                # SQLite 数据库
│   ├── cache/                  # 临时缓存
│   └── raw/                    # 原始抓取数据
│
├── reports/                    # [推荐] 汇报内容管理
│   ├── pending/                # 积攒中、尚未提交的发现
│   │   └── batch-001.json
│   └── submitted/              # 已提交归档
│       └── 2026-03-26-001.json
│
├── logs/                       # [必须] 日志（由 TentacleLogger 自动写入）
│   ├── daemon.log              # 工程层日志
│   ├── agent.log               # Agent 层日志
│   └── consultation.log        # Consultation 日志
│
├── venv/                       # [Python] 虚拟环境
├── node_modules/               # [TypeScript] 依赖
└── SKILL.md                    # [推荐] 蓝图元数据副本
```

---

## 2. 各目录用途与权限

| 目录 | 用途 | 触手可读 | 触手可写 | Brain 可读 |
|------|------|---------|---------|-----------|
| `src/` | 源代码 | ✅ | ❌（部署后不改） | ✅ |
| `prompt/` | prompt 原始文件 | ✅ | ❌ | ✅ |
| `workspace/` | Agent 工作空间 | ✅ | ✅ | ✅ |
| `data/` | 工程层数据 | ✅ | ✅ | ✅ |
| `reports/` | 汇报内容 | ✅ | ✅ | ✅ |
| `logs/` | 日志 | ✅ | ✅ | ✅ |
| `tools/` | 工具定义 | ✅ | ❌ | ✅ |

**触手不可访问的目录：**
- `~/.openceph/workspace/`（Brain workspace）
- `~/.openceph/credentials/`
- `~/.openceph/tentacles/{其他触手}/`
- `~/.openceph/openceph.json`

---

## 3. tentacle.json 完整字段

```json
{
  "id": "t_arxiv_scout",
  "displayName": "arXiv Paper Scout",
  "emoji": "🎓",
  "purpose": "监控 arXiv 最新论文，筛选值得阅读的研究",
  "sourceSkill": "arxiv-paper-scout",
  "sourceSkillVersion": "1.0.0",
  "runtime": "python",
  "entryCommand": "venv/bin/python src/main.py",
  "status": "running",
  "triggerType": "schedule",
  "triggerSchedule": "0 */12 * * *",
  "createdAt": "2026-03-26T10:00:00Z",
  "lastActiveAt": "2026-03-26T16:00:00Z",
  "lastConsultationAt": "2026-03-26T14:30:00Z",

  "capabilities": {
    "daemon": ["rss_fetch", "api_integration", "database"],
    "agent": ["content_analysis", "quality_judgment"],
    "consultation": {
      "mode": "batch",
      "batchThreshold": 5
    }
  },

  "stats": {
    "totalConsultations": 12,
    "totalItemsReported": 47,
    "totalItemsPushedToUser": 15,
    "totalLlmCalls": 89,
    "totalTokensUsed": 245000,
    "totalCostUsd": 0.18,
    "crashCount": 0,
    "uptimeSince": "2026-03-25T08:00:00Z"
  },

  "config": {
    "ARXIV_CATEGORIES": "cs.AI,cs.CL,cs.MA",
    "ARXIV_KEYWORDS": "agent,multi-agent,LLM,reasoning"
  }
}
```

---

## 4. workspace/STATUS.md 格式

触手每次 daemon 循环结束后必须更新此文件：

```markdown
# {触手显示名} — 运行状态

## 当前状态
- **运行状态：** 正常运行中
- **上次工程层执行：** 2026-03-26 16:00 UTC（成功）
- **上次 Agent 激活：** 2026-03-26 14:30 UTC
- **上次向 Brain 汇报：** 2026-03-26 14:30 UTC（推送了 2 篇论文）
- **当前待汇报队列：** 2 条（阈值 5）

## 统计
- 扫描总数：1,247
- 规则筛选通过：189
- Agent 精读保留：47
- 汇报给 Brain：47
- Brain 推送给用户：15

## 数据库状态
- 已记录 ID：1,247 条
- 数据库大小：2.3 MB

## 最近一次执行摘要
2026-03-26 16:00: 从 cs.AI 和 cs.CL 抓取了 31 篇新论文，
规则筛选保留 4 篇，未达到 Agent 激活阈值（需要 5 篇），继续积攒。
```

---

## 5. workspace/REPORTS.md 格式

历史汇报记录的简要摘要：

```markdown
# 历史汇报记录

## 2026-03-26 14:30 — Consultation #cs-001
- 汇报 5 条，Brain 推送 2 条，丢弃 3 条
- 推送：论文 A（Multi-Agent Planning）、论文 B（Chain-of-Reasoning）
- Brain 反馈：多关注方法论创新

## 2026-03-25 20:00 — Consultation #cs-000
- 汇报 3 条，Brain 推送 1 条，丢弃 2 条
- 推送：论文 C（Efficient Retrieval-Augmented Generation）
```

---

## 6. reports/ 目录管理

### pending/ — 待汇报

每批一个 JSON 文件，由触手 Agent 层生成：

```json
{
  "batch_id": "batch-001",
  "created_at": "2026-03-26T14:30:00Z",
  "items": [
    {
      "id": "arxiv-2403-12345",
      "title": "Multi-Agent Planning with LLM",
      "summary": "提出了 MAPLE 框架...",
      "judgment": "important",
      "reason": "与用户 OpenCeph 项目直接相关",
      "source_url": "https://arxiv.org/abs/2403.12345",
      "metadata": {}
    }
  ]
}
```

### submitted/ — 已提交归档

consultation 结束后，将 pending 内容 + consultation 结果合并归档：

```json
{
  "consultation_id": "cs-uuid-001",
  "submitted_at": "2026-03-26T14:35:00Z",
  "items_count": 5,
  "pushed_count": 2,
  "discarded_count": 3,
  "brain_feedback": "多关注方法论创新",
  "items": [ ... ]
}
```
