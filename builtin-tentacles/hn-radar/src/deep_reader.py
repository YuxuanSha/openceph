"""
深度阅读器 — 第二层 Agent 能力。
对通过快速筛选的帖子，用 Jina Reader 抓取原文，LLM 精读后生成结构化评估。
"""

import json
import logging
import requests

log = logging.getLogger("hn_radar.reader")


class DeepReader:
    """
    阶段二：深度阅读。
    用 Jina Reader 抓取原文 → LLM 精读 → 生成结构化评估。
    """

    def __init__(self, llm_client, config):
        self.llm = llm_client
        self.config = config

    def read_and_evaluate(self, post, quick_reason: str) -> dict | None:
        """
        深度阅读一条帖子。
        返回结构化评估结果，如果最终判断不值得汇报则返回 None。
        """
        # 1. 用 Jina Reader 抓取原文
        content = self._fetch_content(post.url)
        if not content:
            log.warning(f"无法抓取原文: {post.url}")
            # 如果抓不到原文，只能基于标题判断
            content = f"（无法抓取原文，仅有标题：{post.title}）"

        # 2. LLM 精读原文
        evaluation = self._evaluate(post, content, quick_reason)
        return evaluation

    def _fetch_content(self, url: str) -> str | None:
        """通过 Jina Reader API 抓取网页内容。"""
        try:
            headers = {
                "Accept": "text/plain",
            }
            if self.config.jina_api_key:
                headers["Authorization"] = f"Bearer {self.config.jina_api_key}"

            resp = requests.get(
                f"{self.config.jina_reader_url}{url}",
                headers=headers,
                timeout=30,
            )
            resp.raise_for_status()

            text = resp.text
            # 截断过长的内容
            if len(text) > 8000:
                text = text[:8000] + "\n\n[... 内容已截断 ...]"

            log.info(f"Jina Reader 抓取成功: {url} ({len(text)} chars)")
            return text

        except Exception as e:
            log.error(f"Jina Reader 抓取失败 {url}: {e}")
            return None

    def _evaluate(self, post, content: str, quick_reason: str) -> dict | None:
        """LLM 精读原文并生成评估。"""
        prompt = f"""你是一个内容分析 Agent。深度阅读以下文章，评估它是否值得推荐给用户。

用户感兴趣的领域：{', '.join(self.config.interests)}
用户不感兴趣的领域：{', '.join(self.config.anti_interests)}

快速筛选阶段的判断：{quick_reason}

文章信息：
- 标题：{post.title}
- HN 热度：{post.score}分，{post.num_comments}条评论
- 发布时间：{post.created_at_relative}
- 原始链接：{post.url}
- HN 讨论：{post.hn_url}

文章原文：
{content}

请分析后给出判断，严格按以下 JSON 格式回复：
{{
  "verdict": "worth_reporting" 或 "skip",
  "importance": "important" 或 "reference",
  "reason": "一句话说明为什么值得/不值得推荐",
  "summary": "3-5句话的核心内容概述（如果 verdict=skip 则留空）",
  "key_points": ["关键要点1", "关键要点2", "..."]
}}

判断标准：
- worth_reporting + important：直接影响用户工作领域，或者是重大技术突破
- worth_reporting + reference：有价值但不紧急，适合日常了解
- skip：虽然通过了快速筛选，但原文内容不够深度/不够相关/是标题党"""

        try:
            response = self.llm.chat(
                messages=[{"role": "user", "content": prompt}],
                temperature=0.2,
            )

            content_text = response.content if hasattr(response, "content") else response["choices"][0]["message"]["content"]
            content_text = content_text.strip()
            if content_text.startswith("```"):
                content_text = content_text.split("\n", 1)[1]
                if content_text.endswith("```"):
                    content_text = content_text[:-3]
                content_text = content_text.strip()

            evaluation = json.loads(content_text)

            if evaluation.get("verdict") == "skip":
                log.info(f"深度阅读后跳过: {post.title} — {evaluation.get('reason')}")
                return None

            log.info(f"深度阅读通过: {post.title} [{evaluation.get('importance')}]")
            return {
                "post": post,
                "importance": evaluation.get("importance", "reference"),
                "reason": evaluation.get("reason", ""),
                "summary": evaluation.get("summary", ""),
                "key_points": evaluation.get("key_points", []),
            }

        except Exception as e:
            log.error(f"LLM 评估失败: {e}")
            return None


class JinaTools:
    """
    Jina API 工具实现 — 供 Agent Loop 中的 tool call 使用。
    """

    def __init__(self, config):
        self.config = config

    def websearch(self, query: str, max_results: int = 5) -> str:
        """Jina Search API — 搜索网页。"""
        try:
            headers = {
                "Accept": "application/json",
            }
            if self.config.jina_api_key:
                headers["Authorization"] = f"Bearer {self.config.jina_api_key}"

            resp = requests.get(
                f"{self.config.jina_search_url}{query}",
                headers=headers,
                timeout=15,
            )
            resp.raise_for_status()

            data = resp.json()
            results = []
            for item in data.get("data", [])[:max_results]:
                results.append(
                    f"**{item.get('title', 'N/A')}**\n"
                    f"URL: {item.get('url', '')}\n"
                    f"{item.get('description', item.get('content', ''))[:500]}\n"
                )

            return "\n---\n".join(results) if results else "未找到相关结果。"

        except Exception as e:
            log.error(f"Jina Search 失败: {e}")
            return f"搜索失败: {e}"

    def webfetch(self, url: str, max_chars: int = 8000) -> str:
        """Jina Reader API — 抓取网页内容。"""
        try:
            headers = {
                "Accept": "text/plain",
            }
            if self.config.jina_api_key:
                headers["Authorization"] = f"Bearer {self.config.jina_api_key}"

            resp = requests.get(
                f"{self.config.jina_reader_url}{url}",
                headers=headers,
                timeout=30,
            )
            resp.raise_for_status()

            text = resp.text
            if len(text) > max_chars:
                text = text[:max_chars] + "\n\n[... 内容已截断 ...]"
            return text

        except Exception as e:
            log.error(f"Jina Reader 失败 {url}: {e}")
            return f"抓取失败: {e}"

    def execute(self, tool_name: str, arguments: dict) -> str:
        """统一工具执行入口。"""
        if tool_name == "websearch":
            return self.websearch(
                query=arguments["query"],
                max_results=arguments.get("max_results", 5),
            )
        elif tool_name == "webfetch":
            return self.webfetch(
                url=arguments["url"],
                max_chars=arguments.get("max_chars", 8000),
            )
        else:
            return f"未知工具: {tool_name}"