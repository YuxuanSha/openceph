# TOOLS.md — 工具使用指南

## 记忆工具
read_memory — 读取 MEMORY.md 的指定 section 或全文
write_memory — 写入记忆到每日日志 memory/YYYY-MM-DD.md
update_memory — 更新已有记忆条目
delete_memory — 删除指定记忆条目
memory_get — 读取指定 memory 文件
memory_search — 搜索 MEMORY.md 和 memory/ 日志中的相关记忆
distill_memory — 将每日日志提炼到 MEMORY.md

## 消息工具
send_to_user — 向用户发送主动消息。系统中唯一允许触达用户的出口。

## 会话工具
sessions_list — 列出最近活跃的 session
sessions_history — 查看指定 session 的最近历史消息

## Heartbeat 工具
create_heartbeat_task — 向 HEARTBEAT.md 添加待处理任务
complete_heartbeat_task — 将 HEARTBEAT.md 中的任务标记为完成

## 技能工具
read_skill — 读取 SKILL 定义文件
skills_list — 列出当前可用的 SKILL

## 触手管理工具

### spawn_from_skill — 部署触手
什么时候用：用户要求部署新触手时。
mode 选择：看 AGENTS.md 中"怎么判断用什么模式"。
config：key 对应 SKILL.md 中 customizable 的 env_var，不确定就 read_skill 看一眼。
brief：场景 B/C 才需要填，场景 A 不填。

### list_tentacles — 查看触手列表
什么时候用：想知道当前有哪些触手、它们的状态。
status_filter 合法值：all、active、running、registered、deploying、pending、paused、weakened、killed、crashed
不存在的值：offline、stopped、dead、error — 不要用这些。
不确定用什么值就用 all，拿到全部列表自己判断。

### manage_tentacle — 管理触手
什么时候用：暂停、恢复、停止、立即运行触手时。

每个 action 的前提条件：
  pause → 触手必须是 running 状态
  resume → 触手必须是 paused 状态
  kill → 触手是 running 或 paused 状态
  run_now → 触手必须是 running 状态（立即触发一次执行）
  strengthen → 触手是 running 状态（升级能力，会调用 Claude Code）
  weaken → 触手是 running 状态（降低触发频率）

常见错误：
  ✗ 对 killed 的触手调 resume → 不行，killed 的触手必须重新 spawn_from_skill
  ✗ 用 strengthen 来修复出错的触手 → 不对，strengthen 是升级功能用的
  ✗ 对 crashed 的触手直接 resume → 应该先 inspect_tentacle_log 看原因

### inspect_tentacle_log — 查看触手日志
什么时候用：触手部署失败、运行异常、想了解触手在做什么时。
这是排查触手问题的第一选择工具。看日志比猜测有用得多。

### read_skill — 读取 SKILL 信息
什么时候用：部署前确认 SKILL 是否存在、查看 customizable 字段、了解触手能力。
每次部署前都应该 read_skill 看一眼，不要凭记忆判断。

### manage_tentacle_schedule — 管理触手的 cron、heartbeat 和自管频率

合法 action 值：
  set_tentacle_cron — 创建 cron 定时触发（需要 cron_config.expr）
  remove_tentacle_cron — 删除 cron job（需要 cron_job_id）
  set_tentacle_heartbeat — 启用心跳（需要 heartbeat_config.every）
  disable_tentacle_heartbeat — 关闭心跳
  set_self_schedule — 设置自管调度间隔（需要 self_schedule_config.interval，如 "1m"、"30m"、"2h"）
  get_schedule — 查看当前调度配置

常见错误：
  ✗ set_self_schedule_interval → 正确名称是 set_self_schedule
  ✗ 不传 self_schedule_config.interval 就调 set_self_schedule → 会报错

注意：action 执行后请检查返回结果确认成功，不要假设一定成功。

### review_tentacles — 复盘所有活跃触手，基于健康度评分返回 weaken/kill/merge/strengthen 建议

## 搜索工具

### web_search — 网页搜索
什么时候用：
  - 用户让你搜索某个话题（"帮我搜一下 xxx"）
  - 触手的工作需要外部数据（新闻、论文、产品信息）
  - 用户问的问题你不确定答案

什么时候绝对不用：
  - OpenCeph 内部系统问题（部署失败、触手崩溃、IPC 错误、配置问题）
  - 这些问题互联网上搜不到任何有用信息
  - 内部问题用 inspect_tentacle_log 或直接读 tool_result 错误信息

### web_fetch — 抓取网页
什么时候用：需要读取某个具体 URL 的内容时。
不要用来抓取 OpenCeph 内部文件（用 read 工具）。

## 文件工具

### read — 读取本地文件
用于读取本地文件系统上的任何文件。包括：
  - 自己 workspace 下的文件
  - 触手目录下的文件（如 ~/.openceph/tentacles/t_xxx/src/requirements.txt）
  - 触手 workspace 下的文件（如 ~/.openceph/tentacles/t_xxx/workspace/STATUS.md）
  - 规范文档（~/.openceph/contracts/skill-tentacle-spec/SPEC.md）

不要用 memory_get 读触手的文件——memory_get 只读 memory/ 目录下的记忆文件。
不要用 web_fetch 读本地文件——web_fetch 只能抓取 HTTP URL。

### write / edit — 写入/编辑文件
只写自己 workspace 下的文件。不要写触手目录下的文件（那是触手自己管的）。

## 代码工具
invoke_code_agent — 生成并落盘新的触手代码（完整 Agent 系统），不会自动宣称已运行；只有 spawned=true 时才表示已启动

## cron
cron_add — 创建定时任务
cron_list — 列出所有定时任务
cron_update — 修改定时任务
cron_remove — 删除定时任务
cron_run — 手动触发定时任务

## 工具使用原则
- 能直接回答的不调工具
- 当前这轮对话的正常回复，直接输出文本；不要调用 send_to_user
- send_to_user 只用于主动通知、异步提醒、非当前会话的外呼
- 用户说"搜一下""查一下""找一下""新闻"等需要实时信息时，必须调用 web_search
- 如果没有实际调用过 web_search，绝不能声称"已经搜过了"
- 搜索结果直接在回复中总结，不需要再调用 send_to_user
- web_fetch 不执行 JS，JS 重度页面需注意
- 调用 invoke_code_agent / spawn_from_skill 后，必须按 tool result 原样区分 generated、deployed、spawned、running，禁止把 deployed 说成已运行
- 只有 tool result 明确给出 spawned=true 或运行态证据时，才能说"已启动/后台运行"
- 只能引用 tool result 或状态系统返回的真实日志路径，禁止臆造 logs/ 目录
