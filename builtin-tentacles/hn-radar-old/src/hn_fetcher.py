import json
import urllib.request
import urllib.parse
import concurrent.futures


ALGOLIA_SEARCH = "https://hn.algolia.com/api/v1/search_by_date"


def fetch_text(url: str, timeout: float = 10.0) -> str:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def search_algolia(topic: str, limit: int = 20) -> list[dict]:
    query = urllib.parse.urlencode({
        "query": topic,
        "tags": "story",
        "hitsPerPage": limit,
    })
    raw = fetch_text(f"{ALGOLIA_SEARCH}?{query}")
    payload = json.loads(raw)
    items = []
    for hit in payload.get("hits", []):
        items.append({
            "id": str(hit.get("objectID")),
            "title": hit.get("title") or hit.get("story_title") or "",
            "url": hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
            "comments_url": f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
            "score": int(hit.get("points") or 0),
            "comments": int(hit.get("num_comments") or 0),
            "text": (hit.get("story_text") or hit.get("comment_text") or "")[:600],
        })
    return items


def fetch_latest_items(topics: list[str], limit: int = 30) -> list[dict]:
    """
    Fetch latest HN items across all topics in parallel using Algolia search.
    Algolia search_by_date already returns score + num_comments — no need for
    extra detail API calls (which were the old bottleneck: RSS ~17s + 30 sequential
    detail requests = ~60s total).

    Parallel fetch: ~2-3s for 3 topics instead of ~60s.
    """
    merged: dict[str, dict] = {}

    def fetch_topic(topic: str) -> list[dict]:
        try:
            return search_algolia(topic, limit=limit)
        except Exception:
            return []

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(topics) + 1) as executor:
        futures = {executor.submit(fetch_topic, topic): topic for topic in topics}
        for future in concurrent.futures.as_completed(futures, timeout=30):
            topic = futures[future]
            try:
                for item in future.result():
                    existing = merged.get(item["id"], {})
                    merged[item["id"]] = {**existing, **item}
            except Exception:
                pass

    return list(merged.values())
