import os
import threading
import time
from pathlib import Path

from db import ReleaseStore
from github_client import fetch_releases, fetch_tags
from ipc_client import IpcClient, load_dotenv


BASE_DIR = Path(__file__).resolve().parents[1]
load_dotenv(str(BASE_DIR))
RUN_NOW = threading.Event()


def build_items(store: ReleaseStore) -> list[dict]:
    repos = [repo.strip() for repo in os.environ.get("WATCH_REPOS", "").split(",") if repo.strip()]
    include_prereleases = os.environ.get("INCLUDE_PRERELEASES", "false").lower() == "true"
    items = []
    for repo in repos:
        for release in fetch_releases(repo):
            key = f"{repo}:{release.get('tag_name')}"
            if store.seen(key):
                continue
            store.mark(key)
            if release.get("prerelease") and not include_prereleases:
                continue
            body = release.get("body") or ""
            has_breaking = "breaking" in body.lower()
            summary = " ".join(line.strip() for line in body.splitlines() if line.strip())[:240] or "No release notes provided."
            items.append({
                "id": key,
                "content": (
                    f"[GitHub Release]\n\n📦 {repo} {release.get('tag_name')} 发布于 {release.get('published_at')}\n"
                    f"变更摘要：{summary}\n"
                    f"Breaking Changes：{'有，需重点关注' if has_breaking else '无'}\n"
                    f"链接：{release.get('html_url')}"
                ),
                "tentacleJudgment": "important" if has_breaking else "reference",
                "reason": "Release watcher detected a new release.",
                "sourceUrl": release.get("html_url"),
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
        for tag in fetch_tags(repo):
            key = f"tag:{repo}:{tag.get('name')}"
            if store.seen(key):
                continue
            store.mark(key)
            items.append({
                "id": key,
                "content": (
                    f"[GitHub Tag]\n\n🏷️ {repo} {tag.get('name')} 发布了新 tag\n"
                    f"提交：{(tag.get('commit') or {}).get('sha', '')[:12]}\n"
                    f"链接：https://github.com/{repo}/tree/{tag.get('name')}"
                ),
                "tentacleJudgment": "reference",
                "reason": "Tag watcher detected a new tag.",
                "sourceUrl": f"https://github.com/{repo}/tree/{tag.get('name')}",
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
    return items


def main():
    tentacle_id = os.environ.get("OPENCEPH_TENTACLE_ID", "github-release-watcher")
    ipc = IpcClient(tentacle_id)
    ipc.connect()
    ipc.register("Monitor GitHub repositories for new releases and tags.", "python")
    store = ReleaseStore(BASE_DIR / "github-release-watcher.db")

    def on_directive(payload: dict):
        if payload.get("action") in {"run_now", "set_self_schedule"}:
            RUN_NOW.set()

    ipc.on_directive(on_directive)
    if os.environ.get("OPENCEPH_TRIGGER_MODE", "self") == "self":
        RUN_NOW.set()

    interval = int(os.environ.get("GH_RELEASE_INTERVAL_SECONDS", "21600"))
    while True:
        RUN_NOW.wait(timeout=interval)
        RUN_NOW.clear()
        items = build_items(store)
        if items:
          ipc.consultation_request("batch", items, f"GitHub Release Watcher found {len(items)} new releases.", "release_watch")


if __name__ == "__main__":
    main()
