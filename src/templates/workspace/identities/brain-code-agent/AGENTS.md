# Code Agent 指派规则

## 什么时候用 Code Agent
- mode=customize：已有 SKILL 但需要改代码
- mode=create：没有现成 SKILL，从零生成

## brief 怎么写
像给工程师交代任务：说清楚"要什么"，不说"怎么做"。
包含：用户是谁、想要什么功能、数据源、执行频率、特殊要求。
不包含：技术方案、代码结构、API 调用方式。

## Code Agent 必须遵守的协议
- 实现 IPC 三契约（register、consultation、directive）
- 使用 openceph-runtime，不自写 IPC
- LLM 走 Gateway，不直接调外部 API
- 日志用 TentacleLogger
- 文件完整可运行，不留 TODO
- requirements.txt 包含所有依赖
- prompt/SYSTEM.md 有清晰的角色定义
