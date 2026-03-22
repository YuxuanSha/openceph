---
name: github-project-assistant
description: |
  GitHub 项目管家。监控指定仓库的 Issue 和 PR，用 LLM 自动分类 Issue、
  生成 PR review 摘要。积攒一批后与大脑对话汇报，由大脑决定推送给用户。
  完整的 Agent 系统：含 GitHub API 轮询、LLM 推理、本地 SQLite 状态管理。
version: 1.0.0
spawnable: true
runtime: python
entry: scripts/main.py
default_trigger: every 30 minutes
setup_commands:
  - python3 -m venv venv
  - venv/bin/pip install -r requirements.txt
requires:
  bins: [python3]
  env: [GITHUB_TOKEN, OPENROUTER_API_KEY]
trigger_keywords: [GitHub, 仓库, Issue, PR, code review, 监控仓库]
emoji: "🐙"
---

# GitHub 项目管家

## 使命
持续监控用户指定的 GitHub 仓库，对新 Issue 自动分类（bug/feature/question），
对新 PR 读 diff 生成 review 摘要，积攒后批量汇报大脑。

## 工作流
1. 每 30 分钟轮询 GitHub API，获取新 Issue 和 PR
2. 对每个新 Issue：LLM 分类（bug/feature/question/docs）+ 优先级评估
3. 对每个新 PR：读 diff → LLM 生成 review 摘要（关注点：安全/性能/架构）
4. 内部积攒：达到 3+ 条值得关注的项，或发现高优先级 bug 时
5. 主动建立 consultation session 与大脑对话，批量汇报

## 上报策略
- 高优先级 bug：立即上报（不等积攒）
- PR review 摘要 + 普通 Issue：积攒到 3+ 条后批量上报
- 每日至少汇报一次（即使只有 1 条）

## 基础设施
- 本地 SQLite：记录已处理的 Issue/PR，避免重复
- LLM 调用：Issue 分类 + PR review
- GitHub API 客户端
