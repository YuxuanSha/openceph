# hn-radar

## 环境变量
- `HN_TOPICS`: 逗号分隔的主题关键词
- `HN_MIN_SCORE`: 最低分数
- `HN_MIN_COMMENTS`: 最低评论数
- `USE_LLM_FILTER`: 是否启用 LLM 二次过滤，默认 `false`
- `LLM_FILTER_CRITERIA`: 启用 LLM 过滤时使用的判断标准
- `HN_INTERVAL_SECONDS`: 自调度轮询间隔，默认 `7200`

## 部署步骤
1. `python3 -m venv venv`
2. `venv/bin/pip install -r src/requirements.txt`
3. 由 OpenCeph 写入 `.env` 后启动 `src/main.py`

## 启动命令
`venv/bin/python src/main.py`

## 运行说明
- IPC 使用 OpenCeph 注入的 `stdin/stdout JSON Lines`，日志请走 `stderr`
- `self` 模式下按 `HN_INTERVAL_SECONDS` 自行轮询
- `external` 模式下等待 `run_now` 指令
- 大分高分帖子会立即上报，其余内容按批次聚合
