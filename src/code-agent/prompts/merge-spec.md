# Tentacle Merge Specification

When merging multiple tentacles into one, follow these rules:

## Principles

1. **Single entry point** — The merged tentacle has one `main.py`/`main.ts` that orchestrates all work
2. **Unified IPC** — One connection, one registration, consolidated reporting
3. **Deduplicate shared logic** — If both tentacles have similar API clients, database schemas, or LLM calls, unify them
4. **Preserve all capabilities** — Every capability from the source tentacles must exist in the merged one
5. **Combined scheduling** — Merge work cycles into one loop with appropriate intervals

## Merge Strategy

### Data Sources
Combine all data sources from source tentacles. Use a unified polling loop
with different intervals per source if needed.

### Database
If both tentacles had databases, design a unified schema that covers both.
Use separate tables where data doesn't overlap.

### Reporting
Consolidate findings from all sources into a single batch consultation.
Tag items with their source domain for the brain to distinguish.

### Configuration
Merge environment variables. If there are conflicts (e.g., both used PORT),
use prefixed names (SOURCE1_PORT, SOURCE2_PORT).

## Output
Generate a complete, self-contained Agent system following the standard
tentacle contract (see contract-spec.md).
