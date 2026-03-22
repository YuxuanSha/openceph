"""
GitHub API client with pagination and rate limit handling.
"""

import logging
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import requests

log = logging.getLogger(__name__)

GITHUB_API_BASE = "https://api.github.com"


class GitHubClient:
    def __init__(self, token: str):
        self._token = token
        self._session = requests.Session()
        self._session.headers.update({
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Authorization": f"token {token}",
        })

    def _check_rate_limit(self, response: requests.Response) -> bool:
        """Check rate limit headers. Returns True if we backed off."""
        remaining = response.headers.get("X-RateLimit-Remaining")
        if remaining is not None and int(remaining) < 100:
            reset_ts = int(response.headers.get("X-RateLimit-Reset", "0"))
            wait = max(reset_ts - int(time.time()), 0)
            log.warning(
                f"Rate limit low: {remaining} remaining. "
                f"Backing off for {min(wait, 300)}s."
            )
            time.sleep(min(wait, 300))
            return True
        return False

    def _get_paginated(self, url: str, params: Optional[dict] = None) -> list[dict]:
        """Fetch all pages from a GitHub API endpoint."""
        results: list[dict] = []
        next_url: Optional[str] = url

        while next_url:
            try:
                response = self._session.get(next_url, params=params, timeout=30)
                params = None  # params are encoded in next_url for subsequent pages

                if response.status_code == 403:
                    log.error(f"GitHub API 403 Forbidden: {next_url}")
                    self._check_rate_limit(response)
                    break

                if response.status_code == 404:
                    log.error(f"GitHub API 404 Not Found: {next_url}")
                    break

                response.raise_for_status()
                self._check_rate_limit(response)

                page_data = response.json()
                if isinstance(page_data, list):
                    results.extend(page_data)
                    if len(page_data) == 0:
                        break
                else:
                    log.error(f"Unexpected response type from {next_url}: {type(page_data)}")
                    break

                # Follow pagination via Link header
                link_header = response.headers.get("Link", "")
                next_url = self._parse_next_link(link_header)

            except requests.RequestException as e:
                log.error(f"GitHub API request failed: {e} — {next_url}")
                break

        return results

    @staticmethod
    def _parse_next_link(link_header: str) -> Optional[str]:
        """Parse the 'next' URL from a GitHub Link header."""
        if not link_header:
            return None
        for part in link_header.split(","):
            part = part.strip()
            if 'rel="next"' in part:
                url_part = part.split(";")[0].strip()
                if url_part.startswith("<") and url_part.endswith(">"):
                    return url_part[1:-1]
        return None

    def get_issues(self, repos: list[str], since_minutes: int = 60) -> list[dict]:
        """Fetch new issues and PRs from the given repos created within the last since_minutes.

        Returns a list of dicts with keys:
            url, title, body, labels, repo, type (issue/pr), author
        """
        since_dt = datetime.now(timezone.utc) - timedelta(minutes=since_minutes)
        since_iso = since_dt.isoformat().replace("+00:00", "Z")

        all_items: list[dict] = []

        for repo in repos:
            log.info(f"Fetching issues for {repo} since {since_iso}...")
            url = f"{GITHUB_API_BASE}/repos/{repo}/issues"
            raw_items = self._get_paginated(url, params={
                "state": "open",
                "sort": "created",
                "direction": "desc",
                "per_page": 100,
                "since": since_iso,
            })
            log.info(f"  Fetched {len(raw_items)} items from {repo}")

            for item in raw_items:
                is_pr = item.get("pull_request") is not None
                labels = [lbl.get("name", "") for lbl in item.get("labels", [])]
                all_items.append({
                    "url": item.get("html_url", ""),
                    "title": item.get("title", ""),
                    "body": item.get("body") or "",
                    "labels": labels,
                    "repo": repo,
                    "type": "pr" if is_pr else "issue",
                    "author": item.get("user", {}).get("login", ""),
                    "created_at": item.get("created_at", ""),
                })

        return all_items
