# HN Engineering Digest

Fetch Hacker News top stories, score engineering relevance with an LLM, deduplicate via SQLite, and deliver outstanding content immediately or in time-bounded batches.

## How It Works

1. Every 6 hours (configurable), fetch the HN Algolia front-page feed.
2. Filter stories by minimum comment count (`MIN_COMMENTS`, default 100).
3. Check each story against the SQLite dedup database — skip if already seen.
4. Score each new story with `QualityScorer` via OpenRouter (GPT-4o-mini by default).
5. Apply the tiered reporting strategy (see below) and send `consultation_request` to brain.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `OPENCEPH_SOCKET_PATH` | IPC Unix socket path (injected by runtime) | — |
| `OPENCEPH_TENTACLE_ID` | Tentacle instance ID (injected by runtime) | `t_hn_digest` |
| `OPENCEPH_TRIGGER_MODE` | `self` (self-scheduled) or `external` (directive-triggered) | `self` |
| `OPENCEPH_STATE_PATH` | Directory for SQLite DB file | `.` |
| `OPENROUTER_API_KEY` | **Required.** OpenRouter API key for LLM scoring | — |
| `OPENROUTER_MODEL` | OpenRouter model ID | `openai/gpt-4o-mini` |
| `MIN_COMMENTS` | Minimum comment count; stories below this are discarded | `100` |
| `WATCHED_TOPICS` | Comma-separated topic keywords for pre-filter | `rust,go,ai,llm,infrastructure,database,systems,compilers,distributed` |
| `ENGINEERING_CRITERIA` | Free-text description of what makes a good engineering post (injected into system prompt) | *(see SKILL.md default)* |
| `FETCH_INTERVAL` | Self-schedule fetch interval (`30m`, `6h`, `1d`) | `6h` |

## Report Strategy

| Quality Score | Action |
|---|---|
| > 0.9 | Send immediately — outstanding engineering content |
| > 0.6 | Batch — send when ≥3 accumulated **or** 24 h elapsed |
| ≤ 0.6 | Discard |
| Day boundary | Guarantee at least 1 report per day; flush whatever is in the batch |

## Prerequisites

- Python 3.10+
- Network access to `hn.algolia.com` and `openrouter.ai`
- OpenCeph IPC socket (automatically provided by the runtime)
- `OPENROUTER_API_KEY` set in environment

## Setup

```bash
pip install -r src/requirements.txt
```

## Running

```bash
# Normal operation (requires IPC socket + OPENROUTER_API_KEY)
python3 src/main.py

# Dry-run: fetch + score stories, print results, no IPC required
python3 src/main.py --dry-run
```

## Customisation

The `prompt/SYSTEM.md` file contains an `{ENGINEERING_CRITERIA}` placeholder. During the Tentacle Creator flow this is replaced with the value of `ENGINEERING_CRITERIA`, letting you tune what counts as a high-quality engineering post without editing code.

```bash
export ENGINEERING_CRITERIA="Focus on Rust, distributed systems, and database internals. Prioritise posts with benchmarks or production war stories."
export MIN_COMMENTS=150
export WATCHED_TOPICS="rust,database,distributed-systems,compilers"
```

## Troubleshooting

### IPC connection fails
Confirm `OPENCEPH_SOCKET_PATH` is set and points to a valid Unix socket. Under normal operation this is injected automatically by the OpenCeph runtime.

### `OPENROUTER_API_KEY` missing
Set the variable before starting, or configure it as a secret in the tentacle spawn dialog.

### No stories pass the filter
- Lower `MIN_COMMENTS` or broaden `WATCHED_TOPICS`.
- Use `--dry-run` to inspect raw fetch results without affecting the database.

### Stories not being scored
Verify network access to `https://openrouter.ai` and that `OPENROUTER_API_KEY` is valid.
