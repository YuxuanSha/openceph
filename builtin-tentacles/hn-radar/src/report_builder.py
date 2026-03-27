"""
汇报构建器 — 将评估结果整理为 consultation 汇报内容。
"""

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

log = logging.getLogger("hn_radar.report")


class ReportBuilder:
    """整理评估结果，生成 consultation 汇报内容。"""

    def __init__(self, config):
        self.config = config
        self.config.reports_path.mkdir(parents=True, exist_ok=True)
        (self.config.reports_path / "pending").mkdir(exist_ok=True)
        (self.config.reports_path / "submitted").mkdir(exist_ok=True)

    def build_consultation_message(
        self,
        evaluated_items: list[dict],
        scan_stats: dict,
    ) -> str:
        """构建发给 Brain 的 consultation 汇报消息。"""
        lang = self.config.report_language
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

        if lang == "中文":
            header = (
                f"我刚完成了一轮 HN 扫描。\n\n"
                f"📊 本轮统计：扫描 {scan_stats.get('total_fetched', '?')} 条 → "
                f"快速筛选保留 {scan_stats.get('quick_pass', '?')} 条 → "
                f"深度阅读后确认 {len(evaluated_items)} 条值得关注。\n\n"
                f"时间：{now}\n\n---\n\n"
            )
        else:
            header = (
                f"Just completed an HN scan.\n\n"
                f"📊 Stats: Scanned {scan_stats.get('total_fetched', '?')} → "
                f"Quick filter kept {scan_stats.get('quick_pass', '?')} → "
                f"Deep read confirmed {len(evaluated_items)} worth reporting.\n\n"
                f"Time: {now}\n\n---\n\n"
            )

        items_text = ""
        for idx, item in enumerate(evaluated_items, 1):
            post = item["post"]
            importance = item["importance"]
            importance_label = "🔴 重要" if importance == "important" else "🔵 参考"

            items_text += (
                f"### {idx}. {post.title}\n"
                f"**HN 热度：** {post.score}分 · {post.num_comments}条评论 · {post.created_at_relative}\n"
                f"**重要程度：** {importance_label}\n"
                f"**为什么值得关注：** {item['reason']}\n\n"
                f"**内容摘要：**\n{item['summary']}\n\n"
            )

            if item.get("key_points"):
                items_text += "**关键要点：**\n"
                for point in item["key_points"]:
                    items_text += f"- {point}\n"
                items_text += "\n"

            items_text += (
                f"**链接：** {post.url}\n"
                f"**HN 讨论：** {post.hn_url}\n\n---\n\n"
            )

        return header + items_text

    def save_pending(self, evaluated_items: list[dict], scan_stats: dict):
        """保存待汇报内容到 pending 目录。"""
        batch_id = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        data = {
            "batch_id": batch_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "scan_stats": scan_stats,
            "items": [
                {
                    "post_id": item["post"].id,
                    "title": item["post"].title,
                    "url": item["post"].url,
                    "hn_url": item["post"].hn_url,
                    "score": item["post"].score,
                    "num_comments": item["post"].num_comments,
                    "importance": item["importance"],
                    "reason": item["reason"],
                    "summary": item["summary"],
                    "key_points": item.get("key_points", []),
                }
                for item in evaluated_items
            ],
        }
        filepath = self.config.reports_path / "pending" / f"batch-{batch_id}.json"
        filepath.write_text(json.dumps(data, ensure_ascii=False, indent=2))
        log.info(f"保存待汇报: {filepath} ({len(evaluated_items)} 条)")

    def archive_submitted(self, batch_id: str, brain_feedback: str):
        """将已提交的汇报归档。"""
        pending_file = self.config.reports_path / "pending" / f"batch-{batch_id}.json"
        if pending_file.exists():
            data = json.loads(pending_file.read_text())
            data["submitted_at"] = datetime.now(timezone.utc).isoformat()
            data["brain_feedback"] = brain_feedback

            archive_name = datetime.now(timezone.utc).strftime("%Y-%m-%d") + f"-{batch_id}.json"
            archive_file = self.config.reports_path / "submitted" / archive_name
            archive_file.write_text(json.dumps(data, ensure_ascii=False, indent=2))
            pending_file.unlink()
            log.info(f"归档汇报: {archive_file}")

    def update_status_md(self, scan_stats: dict, pending_count: int, last_consultation: str):
        """更新 workspace/STATUS.md。"""
        stats = scan_stats
        now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

        content = f"""# HN Radar — 运行状态

## 当前状态
- **运行状态：** 正常运行中
- **上次抓取：** {now}
- **上次汇报：** {last_consultation or '尚未汇报'}
- **当前待汇报队列：** {pending_count} 条（阈值 {self.config.batch_threshold}）

## 累计统计
- 扫描帖子总数：{stats.get('total_fetched', 0)}
- 规则预筛后保留：{stats.get('new_after_dedup', 0)}
- 快速判断后保留：{stats.get('quick_passed_total', 0)}
- 深度阅读后保留：{stats.get('deep_passed_total', 0)}
- 已汇报给 Brain：{stats.get('reported_total', 0)}

## 配置
- 兴趣领域：{', '.join(self.config.interests)}
- 排除领域：{', '.join(self.config.anti_interests)}
- 最低 HN 分数：{self.config.min_score}
- 抓取间隔：{self.config.poll_interval}s
- 批量汇报阈值：{self.config.batch_threshold}
"""
        status_path = self.config.workspace_path / "STATUS.md"
        status_path.write_text(content)