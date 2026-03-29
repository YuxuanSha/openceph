"""
HN RSS Tool System — 封装 hnrss.org + Algolia 全部能力为可调用的 tools.

6 tools: hn_newest, hn_frontpage, hn_ask, hn_show, hn_search, hn_best

Each tool can be called by:
  - Layer 1 daemon loop (based on HN_FEEDS config)
  - Layer 2 AgentLoop (when agent needs more data during analysis)
"""

import json
import re
import time
import urllib.request
import urllib.parse
import xml.etree.ElementTree as ET
from typing import Optional


HNRSS_BASE = "https://hnrss.org"
ALGOLIA_ITEM = "https://hn.algolia.com/api/v1/items/{item_id}"
ALGOLIA_SEARCH = "https://hn.algolia.com/api/v1/search_by_date"


# ─── Low-level helpers ────────────────────────────────────────

def safe_int(val, default: int = 0) -> int:
    """Convert a value to int safely. Handles list-wrapped values from APIs."""
    if val is None:
        return default
    if isinstance(val, list):
        val = val[0] if val else default
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _fetch_text(url: str, timeout: int = 20) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _parse_rss(xml_text: str) -> list[dict]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    items = []
    for entry in root.findall(".//item"):
        title = (entry.findtext("title") or "").strip()
        link = (entry.findtext("link") or "").strip()
        comments_url = (entry.findtext("comments") or "").strip()
        match = re.search(r"id=(\d+)", comments_url or link)
        item_id = match.group(1) if match else link
        if not item_id:
            continue
        items.append({
            "id": str(item_id),
            "title": title,
            "url": link,
            "comments_url": comments_url,
        })
    return items


def _fetch_rss(endpoint: str, log=None) -> list[dict]:
    url = f"{HNRSS_BASE}{endpoint}"
    if log:
        log.daemon("tool_fetch_rss", endpoint=endpoint, url=url)
    try:
        items = _parse_rss(_fetch_text(url))
        if log:
            log.daemon("tool_fetch_rss_done", endpoint=endpoint, items=len(items))
        return items
    except Exception as e:
        if log:
            log.error("tool_fetch_rss_failed", endpoint=endpoint, error=str(e))
        return []


def _fetch_algolia_details(item_id: str) -> dict:
    try:
        raw = _fetch_text(ALGOLIA_ITEM.format(item_id=item_id))
        data = json.loads(raw)
        children = data.get("children") or []
        return {
            "score": safe_int(data.get("points")),
            "comments": len(children),
            "text": (data.get("text") or "")[:600],
        }
    except Exception:
        return {}


def _fetch_algolia_search(query: str, since_ts: int = 0, limit: int = 20, min_points: int = 0, log=None) -> list[dict]:
    if log:
        log.daemon("tool_algolia_search", query=query, since_ts=since_ts)
    try:
        params: dict = {
            "query": query,
            "tags": "story",
            "hitsPerPage": limit,
        }
        if since_ts > 0:
            params["numericFilters"] = f"created_at_i>{since_ts}"
        if min_points > 0:
            existing = params.get("numericFilters", "")
            sep = "," if existing else ""
            params["numericFilters"] = f"{existing}{sep}points>{min_points}"

        url_query = urllib.parse.urlencode(params)
        raw = _fetch_text(f"{ALGOLIA_SEARCH}?{url_query}")
        payload = json.loads(raw)
        items = []
        for hit in payload.get("hits", []):
            items.append({
                "id": str(hit.get("objectID")),
                "title": hit.get("title") or hit.get("story_title") or "",
                "url": hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
                "comments_url": f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
                "score": safe_int(hit.get("points")),
                "comments": safe_int(hit.get("num_comments")),
                "text": (hit.get("story_text") or hit.get("comment_text") or "")[:600],
            })
        if log:
            log.daemon("tool_algolia_search_done", query=query, items=len(items))
        return items
    except Exception as e:
        if log:
            log.error("tool_algolia_search_failed", query=query, error=str(e))
        return []


def enrich_items(items: list[dict], log=None, max_enrich: int = 20):
    """Enrich items missing score/comments via Algolia details API."""
    count = 0
    for item in items:
        if count >= max_enrich:
            break
        if "score" not in item or item.get("score", 0) == 0:
            details = _fetch_algolia_details(str(item.get("id", "")))
            if details:
                item.update(details)
                count += 1
    if log and count > 0:
        log.daemon("enrich_complete", enriched=count)


# ─── Tool implementations ─────────────────────────────────────

def hn_newest(args: dict, log=None) -> list[dict]:
    """获取 HN 最新帖子。按发帖时间倒序。"""
    count = min(int(args.get("count", 50)), 100)
    points = int(args.get("points", 0))
    query = args.get("query", "")
    endpoint = f"/newest?count={count}"
    if points > 0:
        endpoint += f"&points={points}"
    if query:
        endpoint += f"&q={urllib.parse.quote(query)}"
    return _fetch_rss(endpoint, log)


def hn_frontpage(args: dict, log=None) -> list[dict]:
    """获取 HN 当前首页热帖。"""
    count = min(int(args.get("count", 30)), 100)
    return _fetch_rss(f"/frontpage?count={count}", log)


def hn_ask(args: dict, log=None) -> list[dict]:
    """获取 Ask HN 帖子。"""
    count = min(int(args.get("count", 20)), 100)
    points = int(args.get("points", 0))
    endpoint = f"/ask?count={count}"
    if points > 0:
        endpoint += f"&points={points}"
    return _fetch_rss(endpoint, log)


def hn_show(args: dict, log=None) -> list[dict]:
    """获取 Show HN 帖子。"""
    count = min(int(args.get("count", 20)), 100)
    points = int(args.get("points", 0))
    endpoint = f"/show?count={count}"
    if points > 0:
        endpoint += f"&points={points}"
    return _fetch_rss(endpoint, log)


def hn_search(args: dict, log=None) -> list[dict]:
    """搜索 HN 帖子（Algolia API，支持时间窗）。"""
    query = args.get("query", "")
    if not query:
        return []
    count = int(args.get("count", 20))
    since_hours = int(args.get("since_hours", 24))
    min_points = int(args.get("min_points", 0))
    since_ts = int(time.time()) - since_hours * 3600 if since_hours > 0 else 0
    return _fetch_algolia_search(query, since_ts, count, min_points, log)


def hn_best(args: dict, log=None) -> list[dict]:
    """获取 HN 近期最佳帖子。"""
    count = min(int(args.get("count", 30)), 100)
    return _fetch_rss(f"/best?count={count}", log)


# ─── Tool registry ─────────────────────────────────────────────

TOOL_HANDLERS = {
    "hn_newest": hn_newest,
    "hn_frontpage": hn_frontpage,
    "hn_ask": hn_ask,
    "hn_show": hn_show,
    "hn_search": hn_search,
    "hn_best": hn_best,
}


def execute_tool(name: str, args: dict, log=None) -> list[dict]:
    """Execute an HN tool by name. Returns list of item dicts."""
    handler = TOOL_HANDLERS.get(name)
    if not handler:
        raise ValueError(f"Unknown HN tool: {name}")
    items = handler(args, log)
    enrich_items(items, log)
    return items


def get_tool_names() -> list[str]:
    """Return all available HN tool names."""
    return list(TOOL_HANDLERS.keys())
