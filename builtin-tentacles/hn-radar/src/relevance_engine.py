"""
相关性判断引擎 — 第二层 Agent 能力。
调用 LLM Gateway 理解每条 HN 帖子，判断是否与用户兴趣相关。
"""

import json
import logging

log = logging.getLogger("hn_radar.relevance")


class RelevanceEngine:
    """
    阶段一：快速判断。
    把一批帖子的标题和基本信息发给 LLM，批量判断相关性。
    """

    def __init__(self, llm_client, config):
        self.llm = llm_client
        self.config = config

    def batch_judge(self, posts: list) -> list[dict]:
        """
        批量判断帖子相关性。
        返回每条帖子的判断结果：
        [{"post": HNPost, "relevance": "relevant"|"maybe"|"irrelevant", "reason": "..."}]
        """
        results = []
        batch_size = self.config.quick_judge_batch_size

        for i in range(0, len(posts), batch_size):
            batch = posts[i:i + batch_size]
            batch_results = self._judge_batch(batch)
            results.extend(batch_results)

        relevant = [r for r in results if r["relevance"] in ("relevant", "maybe")]
        log.info(
            f"快速判断完成: {len(posts)} 条 → "
            f"relevant {sum(1 for r in results if r['relevance'] == 'relevant')}, "
            f"maybe {sum(1 for r in results if r['relevance'] == 'maybe')}, "
            f"irrelevant {sum(1 for r in results if r['relevance'] == 'irrelevant')}"
        )
        return results

    def _judge_batch(self, batch: list) -> list[dict]:
        """对一批帖子（最多 10 条）调用 LLM 判断。"""
        posts_text = ""
        for idx, post in enumerate(batch):
            posts_text += (
                f"[{idx + 1}] {post.title}\n"
                f"    Score: {post.score} | Comments: {post.num_comments} | {post.created_at_relative}\n"
                f"    URL: {post.url}\n\n"
            )

        prompt = f"""你是一个内容筛选 Agent。判断以下 Hacker News 帖子是否与用户兴趣相关。

用户感兴趣的领域：{', '.join(self.config.interests)}
用户不感兴趣的领域：{', '.join(self.config.anti_interests)}

对每条帖子，给出判断：
- relevant：明确与用户兴趣相关，值得深入阅读
- maybe：可能相关但不确定，需要看原文才能判断
- irrelevant：明确不相关或属于用户不感兴趣的领域

帖子列表：
{posts_text}

请严格按以下 JSON 格式回复，不要添加其他内容：
[
  {{"index": 1, "relevance": "relevant|maybe|irrelevant", "reason": "一句话理由"}},
  ...
]"""

        try:
            response = self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.1,
            )

            # 解析 LLM 返回的 JSON（LlmResponse.content）
            content = response.content if hasattr(response, "content") else response["choices"][0]["message"]["content"]
            # 清理可能的 markdown code block
            content = content.strip()
            if content.startswith("```"):
                content = content.split("\n", 1)[1]
                if content.endswith("```"):
                    content = content[:-3]
                content = content.strip()

            judgments = json.loads(content)

            results = []
            for j in judgments:
                idx = j["index"] - 1
                if 0 <= idx < len(batch):
                    results.append({
                        "post": batch[idx],
                        "relevance": j.get("relevance", "irrelevant"),
                        "reason": j.get("reason", ""),
                    })

            # 补充未被 LLM 覆盖的帖子
            covered = {r["post"].id for r in results}
            for post in batch:
                if post.id not in covered:
                    results.append({
                        "post": post,
                        "relevance": "irrelevant",
                        "reason": "LLM 未返回判断",
                    })

            return results

        except Exception as e:
            log.error(f"LLM 批量判断失败: {e}")
            # 失败时全部标记为 maybe，让深度阅读阶段处理
            return [
                {"post": p, "relevance": "maybe", "reason": f"判断失败: {e}"}
                for p in batch
            ]