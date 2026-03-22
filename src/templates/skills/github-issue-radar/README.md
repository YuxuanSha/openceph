# GitHub Issue Radar — Deployment Guide

A skill_tentacle that monitors GitHub repositories for new issues and PRs, classifies them using LLM reasoning via OpenRouter, deduplicates with SQLite, and reports findings to the OpenCeph Brain with smart batching.

## Requirements

- **Python 3.10+**
- **OpenCeph** runtime with IPC socket available
- **GitHub Personal Access Token** with `repo` scope (or `public_repo` for public repos only)
- **OpenRouter API Key** for LLM-based issue classification

## Environment Variables

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `GITHUB_TOKEN` | Yes | GitHub Personal Access Token | `ghp_xxxxxxxxxxxx` |
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key for LLM classification | `sk-or-xxxxxxxxxxxx` |
| `WATCHED_REPOS` | Yes | Comma-separated list of repos to monitor | `anthropics/claude-code,openai/openai-python` |
| `FOCUS_AREAS` | No | Technical focus areas for relevance classification | `Rust systems programming, LLM inference` |
| `POLL_INTERVAL_MINUTES` | No | Polling interval in minutes (default: `30`) | `60` |
| `OPENCEPH_SOCKET_PATH` | Auto | IPC Unix socket path (set by OpenCeph runtime) | `/tmp/openceph.sock` |
| `OPENCEPH_TENTACLE_ID` | Auto | Unique tentacle ID (set by OpenCeph runtime) | `github-issue-radar-a1b2` |
| `OPENCEPH_TRIGGER_MODE` | Auto | Trigger mode: `self` or `external` (set by OpenCeph runtime) | `self` |

Variables marked **Auto** are injected by the OpenCeph runtime. You only need to configure the others.

## Deployment Steps

1. **Set environment variables** in your OpenCeph configuration or `.env` file:
   ```bash
   export GITHUB_TOKEN="ghp_your_token_here"
   export OPENROUTER_API_KEY="sk-or-your_key_here"
   export WATCHED_REPOS="anthropics/claude-code,openai/openai-python"
   export FOCUS_AREAS="LLM tooling, Python, security vulnerabilities"
   export POLL_INTERVAL_MINUTES="30"
   ```

2. **Install dependencies**:
   ```bash
   pip install -r src/requirements.txt
   ```

3. **Start the skill** (normally done by the OpenCeph runtime):
   ```bash
   python3 src/main.py
   ```

4. **Dry run** (test GitHub API + OpenRouter connectivity without IPC):
   ```bash
   python3 src/main.py --dry-run
   ```

## Start Command

When deployed as a skill_tentacle, OpenCeph will run:

```bash
python3 src/main.py
```

The runtime automatically sets `OPENCEPH_SOCKET_PATH`, `OPENCEPH_TENTACLE_ID`, and `OPENCEPH_TRIGGER_MODE`.

## Architecture

```
main.py
├── GitHubClient      (src/github_client.py) — GitHub REST API with pagination + rate limiting
├── IssueEvaluator    (src/evaluator.py)      — OpenRouter LLM classification
├── IssueDatabase     (src/db.py)             — SQLite deduplication
└── IpcClient         (src/ipc_client.py)     — OpenCeph IPC protocol
```

## Report Strategy

| Urgency | Action |
|---------|--------|
| `immediate` | Send a `consultation_request` immediately (critical bugs, security PRs) |
| `batch` | Accumulate; send when >= 3 items OR after 24 hours |
| `discard` | Drop silently (duplicates, off-topic, noise) |

## Common Issues & Fixes

### "GITHUB_TOKEN not set"
Set the `GITHUB_TOKEN` environment variable. Generate one at https://github.com/settings/tokens with at least `public_repo` scope.

### "OPENROUTER_API_KEY not set"
Set the `OPENROUTER_API_KEY` environment variable. Get a key at https://openrouter.ai/keys.

### "WATCHED_REPOS not set"
Set `WATCHED_REPOS` to a comma-separated list of `owner/repo` strings.

### Rate limiting (HTTP 403)
GitHub's REST API allows 5000 requests/hour with a token. The client checks `X-RateLimit-Remaining` and backs off automatically when below 100 remaining requests. Increase `POLL_INTERVAL_MINUTES` or reduce the number of monitored repos if needed.

### Connection refused on IPC socket
Ensure OpenCeph is running and the socket path is correct. Use `--dry-run` mode to test without IPC.

### No results returned
- Verify the repos exist and are accessible with your token
- Check that `FOCUS_AREAS` accurately describes what you care about
- Review the LLM classification output in dry-run mode

## Personalization Guide

The skill uses an LLM to classify issues based on your `FOCUS_AREAS`. Set this to a natural-language description of your technical interests:

- `"Rust systems programming, memory safety, async runtimes"`
- `"Python web frameworks, API design, database performance"`
- `"LLM inference, model quantization, GPU optimization"`
- `"Security vulnerabilities, CVEs, supply chain attacks"`

The LLM uses this description to score each issue for relevance (`high`, `medium`, `low`, `discard`) and urgency (`immediate`, `batch`, `discard`).
