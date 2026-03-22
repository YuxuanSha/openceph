# Content Pipeline Architecture

## Overview

The content pipeline is a three-stage processing system that transforms raw data from public
content sources into scored, clustered, and formatted content creation ideas.

## Pipeline Stages

### Stage 1: Fetch

Multiple fetchers run in sequence, each targeting a different public content source:

```
HN Fetcher ──┐
              │
DevTo Fetcher ┼──→ Raw Topic List (unified schema)
              │
Reddit Fetcher┘
```

Each fetcher normalizes its source-specific format into a common topic dict:

```python
{
    "id": str,           # source-prefixed unique ID
    "title": str,        # topic title
    "url": str,          # original URL
    "summary": str,      # description or excerpt
    "score": int,        # source engagement metric
    "source": str,       # "hackernews" | "devto" | "reddit"
    "timestamp": str,    # ISO 8601
    "tags": list[str],   # extracted tags/keywords
}
```

### Stage 2: Score and Cluster

The scoring engine evaluates each topic against the user's configured domains:

1. **Keyword matching** — Title matches weighted 3x, summary matches weighted 1x
2. **Exclusion filter** — Topics matching `USER_NOT_INTERESTED` keywords are discarded
3. **Cross-source boost** — Topics appearing in 2+ sources get +2 score
4. **Recency adjustment** — Recent topics (< 6h) get +1, stale topics (> 48h) get -1

After scoring, topics are clustered using Jaccard similarity on tokenized titles.
Clusters with 3+ topics are flagged as trends.

### Stage 3: Format

Scored topics are converted into content ideas and formatted for IPC batch reporting:

1. Each topic with score >= 4 gets a content idea generated
2. Ideas include suggested title, writing angle, target audience, and estimated length
3. Ideas are sorted by score (descending) and capped at 10 per cycle
4. A trend summary is generated from identified clusters
5. Everything is packaged into the `consultation_request` IPC message format

## Data Flow Diagram

```
┌─────────────────┐     ┌──────────────┐     ┌────────────────┐     ┌──────────┐
│  Content Sources │────→│  Fetch Stage │────→│  Score/Cluster │────→│  Format  │
│  (HN, DevTo,    │     │  (urllib)    │     │  (keywords +   │     │  (IPC    │
│   Reddit)       │     │              │     │   Jaccard)     │     │   items) │
└─────────────────┘     └──────────────┘     └────────────────┘     └──────────┘
                                                                         │
                                                                         ▼
                                                                  ┌──────────────┐
                                                                  │ consultation  │
                                                                  │ _request to  │
                                                                  │ OpenCeph Brain│
                                                                  └──────────────┘
```

## Error Handling

- Each fetcher is independently fault-tolerant; one source failure does not block others
- Retry logic: 3 attempts with exponential backoff (1s, 2s, 4s)
- Malformed entries are logged and skipped; they do not interrupt the pipeline
- If all sources fail for 3 consecutive cycles, a connectivity warning is reported to the brain

## Performance Considerations

- All HTTP requests use `urllib.request` with a 15-second timeout
- Topics are deduplicated in memory by normalized title hash
- Scan cycle is designed to complete within 60 seconds under normal conditions
- Memory footprint is minimal: only current cycle's topics are held in memory
