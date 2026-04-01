"""
HN Fetcher — orchestrates multi-feed data collection using hn_tools.

This module translates HN_FEEDS config into tool calls and merges results.
"""

import urllib.parse
from hn_tools import execute_tool, enrich_items, safe_int


def fetch_items(
    feeds: list[str],
    topics: list[str],
    fetch_count: int = 50,
    last_fetch_ts: int = 0,
    log=None,
) -> list[dict]:
    """
    Fetch HN items from configured feeds using the tool system.

    feeds: list of feed names (newest, frontpage, ask, show, search)
    topics: keyword list for search feed
    fetch_count: items per feed
    last_fetch_ts: unix timestamp for incremental Algolia queries
    """
    merged: dict[str, dict] = {}

    def merge(items: list[dict]):
        for item in items:
            item_id = str(item.get("id", ""))
            if not item_id:
                continue
            existing = merged.get(item_id)
            if existing:
                if safe_int(item.get("score")) > safe_int(existing.get("score")):
                    merged[item_id] = {**existing, **item}
            else:
                merged[item_id] = item

    # Map feed names to tool calls
    for feed in feeds:
        feed = feed.strip().lower()
        try:
            if feed == "newest":
                merge(execute_tool("hn_newest", {"count": fetch_count}, log))
            elif feed == "frontpage":
                merge(execute_tool("hn_frontpage", {"count": fetch_count}, log))
            elif feed == "ask":
                merge(execute_tool("hn_ask", {"count": fetch_count}, log))
            elif feed == "show":
                merge(execute_tool("hn_show", {"count": fetch_count}, log))
            elif feed == "best":
                merge(execute_tool("hn_best", {"count": fetch_count}, log))
            elif feed == "search":
                for topic in topics:
                    # RSS keyword search
                    merge(execute_tool("hn_newest", {
                        "count": 30,
                        "query": topic,
                    }, log))
                    # Algolia time-windowed search
                    since_hours = max(1, int((last_fetch_ts - 1) / 3600)) if last_fetch_ts > 0 else 24
                    merge(execute_tool("hn_search", {
                        "query": topic,
                        "count": 20,
                        "since_hours": since_hours,
                    }, log))
        except Exception as e:
            if log:
                log.error("fetch_feed_failed", feed=feed, error=str(e))

    if log:
        log.daemon("fetch_all_complete", total_unique=len(merged),
                   feeds=feeds, topics=topics)

    return list(merged.values())
