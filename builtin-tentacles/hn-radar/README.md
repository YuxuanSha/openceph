# hn-radar

## 环境变量
- `HN_TOPICS`: 逗号分隔的主题关键词
- `HN_MIN_SCORE`: 最低分数
- `HN_MIN_COMMENTS`: 最低评论数
- `HN_INTERVAL_SECONDS`: 自调度轮询间隔，默认 `7200`

## 部署步骤
1. `python3 -m venv venv`
2. `venv/bin/pip install -r src/requirements.txt`
3. 由 OpenCeph 写入 `.env` 后启动 `src/main.py`

## 启动命令
`venv/bin/python src/main.py`
