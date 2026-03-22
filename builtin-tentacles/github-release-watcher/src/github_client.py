import json
import os
import urllib.request


def _fetch(url: str) -> list[dict]:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "OpenCeph/github-release-watcher"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_releases(repo: str) -> list[dict]:
    return _fetch(f"https://api.github.com/repos/{repo}/releases?per_page=10")


def fetch_tags(repo: str) -> list[dict]:
    return _fetch(f"https://api.github.com/repos/{repo}/tags?per_page=10")
