# GitHub REST API Reference — Endpoints Used

This document lists the GitHub REST API endpoints used by the GitHub Issue Radar skill.

## List Repository Issues

```
GET /repos/{owner}/{repo}/issues
```

Returns issues and pull requests for a repository. By default, returns open issues sorted by creation date descending.

**Query parameters used:**

| Parameter | Value | Description |
|-----------|-------|-------------|
| `state` | `open` | Only open issues |
| `sort` | `created` | Sort by creation date |
| `direction` | `desc` | Newest first |
| `since` | ISO 8601 timestamp | Only issues created/updated after this time |
| `per_page` | `100` | Maximum results per page |

**Response fields used:**

| Field | Type | Description |
|-------|------|-------------|
| `number` | integer | Issue number |
| `title` | string | Issue title |
| `html_url` | string | URL to view in browser |
| `body` | string | Issue body text (may be null) |
| `created_at` | string | ISO 8601 creation timestamp |
| `labels` | array | Array of label objects |
| `pull_request` | object or null | Present if this is a PR |

**Note:** The issues endpoint returns both issues and pull requests. Items with a `pull_request` field are PRs.

## Rate Limiting

All responses include rate limit headers:

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests per hour (5000 with token) |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |

When `X-RateLimit-Remaining` drops below 100, the skill backs off and waits until the reset time.

## Authentication

All requests include the header:

```
Authorization: token {GITHUB_TOKEN}
```

A Personal Access Token with `public_repo` scope is sufficient for public repositories. For private repositories, the `repo` scope is required.

## Reference

- [GitHub REST API — Issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues)
- [GitHub REST API — Rate Limiting](https://docs.github.com/en/rest/overview/resources-in-the-rest-api#rate-limiting)
