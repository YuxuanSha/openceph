# arxiv-paper-scout

## 环境变量
- `ARXIV_CATEGORIES`: 逗号分隔分类
- `ARXIV_KEYWORDS`: 逗号分隔关键词
- `OPENROUTER_API_KEY`: 必需，用于 LLM 评估与摘要
- `QUALITY_CRITERIA`: 论文筛选标准

## 部署步骤
1. `python3 -m venv venv`
2. `venv/bin/pip install -r src/requirements.txt`
3. OpenCeph 写入 `.env`

## 启动命令
`venv/bin/python src/main.py`

## 运行说明
- IPC 使用 OpenCeph 注入的 `stdin/stdout JSON Lines`
- `self` 模式下按 `ARXIV_INTERVAL_SECONDS` 轮询 arXiv API
- 触手会先按分类与关键词过滤，再调用 LLM 做质量把关
