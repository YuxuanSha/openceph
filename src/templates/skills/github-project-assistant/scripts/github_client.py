"""
GitHub API client for fetching issues and PRs.
"""

import requests
from typing import Optional


class GitHubClient:
    BASE_URL = "https://api.github.com"

    def __init__(self, token: str):
        self.session = requests.Session()
        if token:
            self.session.headers["Authorization"] = f"token {token}"
        self.session.headers["Accept"] = "application/vnd.github.v3+json"

    def get_new_issues(self, repo: str, since_number: Optional[int] = None) -> list[dict]:
        """Fetch issues newer than since_number."""
        url = f"{self.BASE_URL}/repos/{repo}/issues"
        params = {"state": "open", "sort": "created", "direction": "desc", "per_page": 30}
        resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()

        issues = []
        for item in resp.json():
            if "pull_request" in item:
                continue  # Skip PRs in issues endpoint
            if since_number and item["number"] <= since_number:
                break
            issues.append({
                "number": item["number"],
                "title": item["title"],
                "body": (item.get("body") or "")[:2000],
                "labels": [l["name"] for l in item.get("labels", [])],
                "html_url": item["html_url"],
                "created_at": item["created_at"],
                "user": item["user"]["login"],
            })
        return issues

    def get_new_prs(self, repo: str, since_number: Optional[int] = None) -> list[dict]:
        """Fetch PRs newer than since_number."""
        url = f"{self.BASE_URL}/repos/{repo}/pulls"
        params = {"state": "open", "sort": "created", "direction": "desc", "per_page": 20}
        resp = self.session.get(url, params=params, timeout=30)
        resp.raise_for_status()

        prs = []
        for item in resp.json():
            if since_number and item["number"] <= since_number:
                break
            # Fetch diff for review
            diff = self._get_pr_diff(repo, item["number"])
            prs.append({
                "number": item["number"],
                "title": item["title"],
                "body": (item.get("body") or "")[:2000],
                "html_url": item["html_url"],
                "diff": diff[:5000],  # Truncate large diffs
                "created_at": item["created_at"],
                "user": item["user"]["login"],
                "changed_files": item.get("changed_files", 0),
            })
        return prs

    def _get_pr_diff(self, repo: str, pr_number: int) -> str:
        """Fetch PR diff."""
        url = f"{self.BASE_URL}/repos/{repo}/pulls/{pr_number}"
        headers = {"Accept": "application/vnd.github.v3.diff"}
        try:
            resp = self.session.get(url, headers=headers, timeout=30)
            resp.raise_for_status()
            return resp.text
        except Exception:
            return ""
