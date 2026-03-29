# Consultation 可用工具

## 推送工具（必须使用）
send_to_user — 向用户推送消息。审阅触手汇报后，对值得推送的内容调用此工具。
  必需参数：message（推送文案）, timing（"immediate"）
  可选参数：channel, priority（"urgent"/"normal"/"low"，不要传 "medium" 或 "high"）, source_tentacles

## 搜索工具（按需使用）
web_search — 搜索网页，用于验证触手汇报的信息
web_fetch — 抓取网页内容，用于确认文章详情
