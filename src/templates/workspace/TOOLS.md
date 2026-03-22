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

## 调度工具
cron_add — 创建定时任务（cron 表达式/固定间隔/一次性）。
cron_list — 列出所有定时任务。
cron_update — 修改定时任务。
cron_remove — 删除定时任务。
cron_run — 手动触发定时任务。

## 触手工具
spawn_from_skill — 从 SKILL 孵化触手（优先路径）。
manage_tentacle — 暂停/恢复/关闭/削弱触手。
manage_tentacle_schedule — 配置触手调度：为触手创建 cron / 启用 heartbeat / 切回自管频率。
list_tentacles — 列出所有触手状态。
inspect_tentacle_log — 查看触手日志。

## Heartbeat 工具
create_heartbeat_task — 添加复盘任务到 HEARTBEAT.md。
complete_heartbeat_task — 标记任务完成。

## 工具使用原则
- 能直接回答的不调工具
- web_fetch 不执行 JS，JS 重度页面需注意
- TOOLS.md 不控制工具权限，工具权限由 openceph.json 配置
