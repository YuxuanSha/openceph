# skill-tentacle-creator

## 环境变量
- `OPENROUTER_API_KEY`: 可选，用于后续接入更强的生成流程。
- `CREATOR_OUTPUT_DIR`: 可选，生成目录，默认写到当前目录下的 `generated-tentacles/`。
- `CREATOR_TENTACLE_NAME`: 可选，默认生成的触手名。
- `CREATOR_PURPOSE`: 可选，默认生成触手的使命描述。

## 部署步骤
1. `python3 -m venv venv`
2. `venv/bin/pip install -r src/requirements.txt`
3. 由 OpenCeph 注入 `.env` 并启动 `src/main.py`

## 启动命令
`venv/bin/python src/main.py`

## 说明
这个内置触手是一个元触手。它默认待机，收到 `run_now` 指令后会生成一个最小可运行的 `skill_tentacle` 脚手架，并用本地校验器做结构检查。
