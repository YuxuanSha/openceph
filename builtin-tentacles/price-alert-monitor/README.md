# price-alert-monitor

## 环境变量
- `WATCH_ITEMS_JSON`: 监控项 JSON 数组
- `PRICE_INTERVAL_SECONDS`: 自调度间隔

## 部署步骤
1. `python3 -m venv venv`
2. `venv/bin/pip install -r src/requirements.txt`
3. 写入 `.env` 后启动

## 启动命令
`venv/bin/python src/main.py`
