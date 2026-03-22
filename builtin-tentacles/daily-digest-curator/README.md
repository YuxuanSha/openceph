# daily-digest-curator

## 环境变量
- `OPENROUTER_API_KEY`: 可选，后续可接入更强摘要。
- `DIGEST_STYLE`: 简报风格。
- `DIGEST_INPUT_JSON`: 可选，直接注入待整合信息的 JSON 数组。

## 部署步骤
1. `python3 -m venv venv`
2. `venv/bin/pip install -r src/requirements.txt`
3. OpenCeph 写入 `.env` 并运行

## 启动命令
`venv/bin/python src/main.py`
