# uptime-watchdog

## 环境变量
- `WATCH_ENDPOINTS`: JSON 数组，每项包含 `name`、`url`、`timeout`
- `CHECK_INTERVAL_SECONDS`: 默认 300

## 部署步骤
1. `python3 -m venv venv`
2. `venv/bin/pip install -r src/requirements.txt`
3. OpenCeph 写入 `.env`

## 启动命令
`venv/bin/python src/main.py`
