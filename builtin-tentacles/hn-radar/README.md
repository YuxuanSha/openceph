# HN Radar v1.4.0

General-purpose Hacker News monitoring tentacle. Three-layer filtering architecture (Rules -> LLM -> Brain review), finding truly noteworthy technical content from hundreds of daily HN posts.

## Architecture

### Layer 1: Data Collection + Rule-Based Pre-Filtering
- Supports 6 data sources: newest, frontpage, ask, show, best, search
- Multiple data sources can be enabled simultaneously (`HN_FEEDS=newest,frontpage,search`)
- Search source supports Algolia time-window incremental queries
- Optional rule-based filtering (min_score, min_comments), disabled by default (deferred to LLM)
- Smart deduplication: cross-source merging + exclusion of processed/rejected items

### Layer 2: LLM-Powered Smart Filtering
- Enabled by default (`USE_LLM_FILTER=true`)
- Evaluates in batches (batch_size=5), one LLM call per batch
- Filtering criteria can be customized in natural language (`LLM_FILTER_CRITERIA`)
- Fail-open on LLM failure (accepts all items, no data loss)

### Layer 3: Brain Review + User Notification
- Batch reporting (default 3 items per batch, reports immediately on first run)
- Hot posts (score >= 300 + importance: high) are reported individually and immediately
- Supports Brain follow-up queries; tentacle can invoke websearch/webfetch for additional information

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HN_TOPICS` | `AI,LLM,agent,startup` | Topics of interest (comma-separated), used for search source and LLM evaluation |
| `HN_FEEDS` | `newest` | Data sources (comma-separated): newest, frontpage, ask, show, best, search |
| `HN_FETCH_COUNT` | `50` | Number of items to fetch per data source per run (RSS max 100) |
| `HN_MIN_SCORE` | `0` | Minimum score (0 = no filtering, defer to LLM) |
| `HN_MIN_COMMENTS` | `0` | Minimum comment count (0 = no filtering) |
| `USE_LLM_FILTER` | `true` | Enable LLM-powered smart filtering |
| `LLM_FILTER_CRITERIA` | Filter for engineering content | LLM filtering criteria (natural language) |
| `BATCH_SIZE` | `3` | Batch reporting threshold |
| `HN_INTERVAL_SECONDS` | `7200` | Scan interval (seconds), can be set to 60 for high-frequency mode |

## Deployment

Automatically deployed by OpenCeph Brain via `spawn_from_skill`.

### Quick Deployment (default config, works out of the box)
```
deploy(config: {})
```

### Custom Deployment Example
```
deploy(config: {
    HN_FEEDS: "newest,frontpage",
    HN_INTERVAL_SECONDS: "60",
    HN_TOPICS: "AI,Rust,distributed",
    USE_LLM_FILTER: "true",
    BATCH_SIZE: "1",
})
```

## Operating Modes
- `self` mode: polls on its own according to `HN_INTERVAL_SECONDS`
- `external` mode: waits for Brain to send `run_now` command
- IPC uses stdin/stdout JSON Lines; logs go to stderr
