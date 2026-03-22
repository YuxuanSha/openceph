# github-release-watcher

## 环境变量
- `GITHUB_TOKEN`: GitHub API token
- `WATCH_REPOS`: 逗号分隔的 `owner/repo`
- `INCLUDE_PRERELEASES`: `true/false`

## 部署步骤
1. `python3 -m venv venv`
2. `venv/bin/pip install -r src/requirements.txt`
3. 由 OpenCeph 注入 `.env` 后启动

## 启动命令
`venv/bin/python src/main.py`
