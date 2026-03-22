import json
import re
import urllib.request
import xml.etree.ElementTree as ET
import urllib.parse


RSS_URL = "https://hnrss.org/newest?points=10"
ALGOLIA_ITEM = "https://hn.algolia.com/api/v1/items/{item_id}"
ALGOLIA_SEARCH = "https://hn.algolia.com/api/v1/search_by_date"


def fetch_text(url: str) -> str:
    with urllib.request.urlopen(url, timeout=20) as response:
        return response.read().decode("utf-8", errors="replace")


def parse_rss(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    items = []
    for entry in root.findall(".//item"):
        title = (entry.findtext("title") or "").strip()
        link = (entry.findtext("link") or "").strip()
        comments = (entry.findtext("comments") or "").strip()
        guid = (entry.findtext("guid") or link or title).strip()
        match = re.search(r"id=(\d+)", comments or link)
        items.append({
            "id": match.group(1) if match else guid,
            "title": title,
            "url": link,
            "comments_url": comments,
        })
    return items


def fetch_algolia_details(item_id: str) -> dict:
    try:
        raw = fetch_text(ALGOLIA_ITEM.format(item_id=item_id))
        data = json.loads(raw)
        return {
            "score": int(data.get("points") or 0),
            "comments": int(data.get("children") and len(data.get("children")) or 0),
            "text": (data.get("text") or "")[:600],
        }
    except Exception:
        return {"score": 0, "comments": 0, "text": ""}


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
    merged: dict[str, dict] = {}

    for item in parse_rss(fetch_text(RSS_URL))[:limit]:
        details = fetch_algolia_details(item["id"])
        item.update(details)
        merged[item["id"]] = item

    for topic in topics:
        try:
            for item in search_algolia(topic, limit=limit):
                existing = merged.get(item["id"], {})
                merged[item["id"]] = {**existing, **item}
        except Exception:
            continue

    return list(merged.values())
