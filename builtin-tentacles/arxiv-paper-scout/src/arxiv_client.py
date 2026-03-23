import re
import xml.etree.ElementTree as ET
import requests


def fetch_entries(categories: list[str], limit: int = 20) -> list[dict]:
    query = " OR ".join(f"cat:{cat}" for cat in categories)
    response = requests.get(
        "https://export.arxiv.org/api/query",
        params={
            "search_query": query,
            "start": 0,
            "max_results": limit,
            "sortBy": "submittedDate",
            "sortOrder": "descending",
        },
        headers={"User-Agent": "OpenCeph arxiv-paper-scout/1.0"},
        timeout=20,
    )
    response.raise_for_status()
    root = ET.fromstring(response.text)
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
