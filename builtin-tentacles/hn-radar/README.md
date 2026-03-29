# HN Radar v1.4.0

Hacker News 通用监控触手。三层过滤架构（规则 → LLM → Brain 审阅），从每日数百条 HN 帖子中找出真正值得关注的技术内容。

## 架构

### Layer 1: 数据采集 + 规则预过滤
- 支持 6 种数据源：newest, frontpage, ask, show, best, search
- 多数据源可同时启用（`HN_FEEDS=newest,frontpage,search`）
- search 源支持 Algolia 时间窗增量查询
- 可选规则过滤（min_score, min_comments），默认关闭（交给 LLM）
- 智能去重：跨数据源合并 + 已处理/已拒绝项排除

### Layer 2: LLM 智能过滤
- 默认开启（`USE_LLM_FILTER=true`）
- 按批评估（batch_size=5），每批一次 LLM 调用
- 筛选标准可自然语言自定义（`LLM_FILTER_CRITERIA`）
- LLM 失败时 fail-open（接受全部，不丢数据）

### Layer 3: Brain 审阅 + 用户推送
- 批量汇报（默认 3 条一批，首次运行立即汇报）
- 热帖（score >= 300 + importance: high）立即单独上报
- 支持 Brain 追问，触手可调用 websearch/webfetch 补充信息

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `HN_TOPICS` | `AI,LLM,agent,startup` | 关注主题（逗号分隔），用于 search 源和 LLM 判断 |
| `HN_FEEDS` | `newest` | 数据源（逗号分隔）：newest, frontpage, ask, show, best, search |
| `HN_FETCH_COUNT` | `50` | 每个数据源每次抓取数量（RSS 最大 100） |
| `HN_MIN_SCORE` | `0` | 最低分数（0=不过滤，交给 LLM） |
| `HN_MIN_COMMENTS` | `0` | 最低评论数（0=不过滤） |
| `USE_LLM_FILTER` | `true` | 是否启用 LLM 智能过滤 |
| `LLM_FILTER_CRITERIA` | 筛选工程内容 | LLM 筛选标准（自然语言） |
| `BATCH_SIZE` | `3` | 批量汇报阈值 |
| `HN_INTERVAL_SECONDS` | `7200` | 扫描间隔（秒），可设为 60 实现高频 |

## 部署

由 OpenCeph Brain 通过 `spawn_from_skill` 自动部署。

### 快速部署（默认配置，开箱即用）
```
deploy(config: {})
```

### 自定义部署示例
```
deploy(config: {
    HN_FEEDS: "newest,frontpage",
    HN_INTERVAL_SECONDS: "60",
    HN_TOPICS: "AI,Rust,distributed",
    USE_LLM_FILTER: "true",
    BATCH_SIZE: "1",
})
```

## 运行模式
- `self` 模式：按 `HN_INTERVAL_SECONDS` 自行轮询
- `external` 模式：等待 Brain 发送 `run_now` 指令
- IPC 使用 stdin/stdout JSON Lines，日志走 stderr
