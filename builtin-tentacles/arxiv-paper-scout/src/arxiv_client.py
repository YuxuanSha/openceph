import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def fetch_entries(categories: list[str], limit: int = 20) -> list[dict]:
    query = " OR ".join(f"cat:{cat}" for cat in categories)
    url = "https://export.arxiv.org/api/query?" + urllib.parse.urlencode({
        "search_query": query,
        "start": 0,
        "max_results": limit,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    })
    with urllib.request.urlopen(url, timeout=20) as response:
        root = ET.fromstring(response.read().decode("utf-8", errors="replace"))
    ns = {"atom": "http://www.w3.org/2005/Atom"}
    items = []
    for entry in root.findall("atom:entry", ns):
        items.append({
            "id": entry.findtext("atom:id", "", ns),
            "title": re.sub(r"\s+", " ", entry.findtext("atom:title", "", ns)).strip(),
            "summary": re.sub(r"\s+", " ", entry.findtext("atom:summary", "", ns)).strip(),
            "published": entry.findtext("atom:published", "", ns),
        })
    return items
