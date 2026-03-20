# TOOLS.md — 工具使用指南

## 核心工具
send_to_user — 向用户发消息。timing: immediate（立即）/ best_time（合适时间）/ morning_digest（晨报合并）。
read_memory — 读取 MEMORY.md 或 memory/ 目录下的记忆文件。
write_memory — 写入新记忆到 memory/YYYY-MM-DD.md。
update_memory — 通过 memoryId 更新已有记忆条目。
delete_memory — 通过 memoryId 删除记忆条目。
memory_get — 读取 workspace 中的任意文件（带行范围支持）。
distill_memory — 将日记忆提炼到 MEMORY.md（Heartbeat 时调用）。
read_skill — 读取 SKILL 文件内容（M1 暂未启用）。

## 网页工具
web_search — 搜索网页（DuckDuckGo），结果缓存 15 分钟。用户说"帮我搜一下"时调用。
web_fetch — 抓取指定 URL 的网页内容（纯文本）。

## 工具使用原则
- 能直接回答的不调工具
- web_fetch 不执行 JS，JS 重度页面需注意
- TOOLS.md 不控制工具权限，工具权限由 openceph.json 配置
