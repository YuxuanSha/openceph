import json
import re
import urllib.request
from bs4 import BeautifulSoup


def load_watch_items(raw: str) -> list[dict]:
    try:
        return json.loads(raw or "[]")
    except Exception:
        return []


def fetch_price(url: str) -> float | None:
    return fetch_price_for_watch({"url": url})


def fetch_price_for_watch(watch: dict) -> float | None:
    url = watch["url"]
    with urllib.request.urlopen(url, timeout=20) as response:
        raw = response.read().decode("utf-8", errors="replace")

    if watch.get("json_path"):
        try:
            data = json.loads(raw)
            current = data
            for part in str(watch["json_path"]).split("."):
                current = current[part]
            return float(current)
        except Exception:
            pass

    if watch.get("selector"):
        try:
            soup = BeautifulSoup(raw, "html.parser")
            node = soup.select_one(str(watch["selector"]))
            if node:
                text = node.get_text(" ", strip=True)
                match = re.search(r"(\d+(?:\.\d{1,2})?)", text.replace(",", ""))
                if match:
                    return float(match.group(1))
        except Exception:
            pass

    text = raw
    if watch.get("pattern"):
        match = re.search(str(watch["pattern"]), raw, re.I | re.S)
        if match and match.groups():
            return float(match.group(1).replace(",", ""))

    match = re.search(r"(\d+(?:\.\d{1,2})?)", text.replace(",", ""))
    return float(match.group(1)) if match else None
