# arxiv-paper-scout

## 环境变量
- `ARXIV_CATEGORIES`: 逗号分隔分类
- `ARXIV_KEYWORDS`: 逗号分隔关键词
- `OPENROUTER_API_KEY`: 可选，预留给更强摘要流程

## 部署步骤
1. `python3 -m venv venv`
2. `venv/bin/pip install -r src/requirements.txt`
3. OpenCeph 写入 `.env`

## 启动命令
`venv/bin/python src/main.py`
