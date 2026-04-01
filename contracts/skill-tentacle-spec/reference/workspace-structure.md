# Workspace Directory Structure Complete Specification

**File location:** `contracts/skill-tentacle-spec/reference/workspace-structure.md`
**Purpose:** Complete definition of the tentacle runtime directory structure

---

## 1. Tentacle Root Directory

Each tentacle is deployed under `~/.openceph/tentacles/{tentacle_id}/`:

```
~/.openceph/tentacles/{tentacle_id}/
│
├── tentacle.json               # [Required] Tentacle metadata (runtime state, config snapshot)
├── .env                        # [Required] Environment variables (auto-generated at deployment)
│
├── src/                        # [Required] Engineering source code
│   ├── main.py                 # Entry file
│   ├── requirements.txt        # Dependencies
│   └── ...                     # Other source files
│
├── prompt/                     # [Required] Agent prompt source files
│   └── SYSTEM.md               # Tentacle system prompt (original version with placeholders)
│
├── tools/                      # [If custom tools exist] Tool definitions
│   └── tools.json
│
├── workspace/                  # [Required] Tentacle workspace (Agent read/write)
│   ├── SYSTEM.md               # System prompt with placeholders filled (used at runtime)
│   ├── STATUS.md               # Runtime status (maintained by tentacle)
│   └── REPORTS.md              # Historical report summaries (maintained by tentacle)
│
├── data/                       # [Recommended] Engineering layer persistent data
│   ├── state.db                # SQLite database
│   ├── cache/                  # Temporary cache
│   └── raw/                    # Raw fetched data
│
├── reports/                    # [Recommended] Report content management
│   ├── pending/                # Accumulated items not yet submitted
│   │   └── batch-001.json
│   └── submitted/              # Submitted and archived
│       └── 2026-03-26-001.json
│
├── logs/                       # [Required] Logs (automatically written by TentacleLogger)
│   ├── daemon.log              # Engineering layer logs
│   ├── agent.log               # Agent layer logs
│   └── consultation.log        # Consultation logs
│
├── venv/                       # [Python] Virtual environment
├── node_modules/               # [TypeScript] Dependencies
└── SKILL.md                    # [Recommended] Copy of blueprint metadata
```

---

## 2. Directory Purposes and Permissions

| Directory | Purpose | Tentacle Readable | Tentacle Writable | Brain Readable |
|-----------|---------|-------------------|-------------------|----------------|
| `src/` | Source code | Yes | No (immutable after deployment) | Yes |
| `prompt/` | Prompt source files | Yes | No | Yes |
| `workspace/` | Agent workspace | Yes | Yes | Yes |
| `data/` | Engineering layer data | Yes | Yes | Yes |
| `reports/` | Report content | Yes | Yes | Yes |
| `logs/` | Logs | Yes | Yes | Yes |
| `tools/` | Tool definitions | Yes | No | Yes |

**Directories not accessible to the tentacle:**
- `~/.openceph/workspace/` (Brain workspace)
- `~/.openceph/credentials/`
- `~/.openceph/tentacles/{other_tentacles}/`
- `~/.openceph/openceph.json`

---

## 3. tentacle.json Complete Fields

```json
{
  "id": "t_arxiv_scout",
  "displayName": "arXiv Paper Scout",
  "emoji": "🎓",
  "purpose": "Monitor latest arXiv papers and filter research worth reading",
  "sourceSkill": "arxiv-paper-scout",
  "sourceSkillVersion": "1.0.0",
  "runtime": "python",
  "entryCommand": "venv/bin/python src/main.py",
  "status": "running",
  "triggerType": "schedule",
  "triggerSchedule": "0 */12 * * *",
  "createdAt": "2026-03-26T10:00:00Z",
  "lastActiveAt": "2026-03-26T16:00:00Z",
  "lastConsultationAt": "2026-03-26T14:30:00Z",

  "capabilities": {
    "daemon": ["rss_fetch", "api_integration", "database"],
    "agent": ["content_analysis", "quality_judgment"],
    "consultation": {
      "mode": "batch",
      "batchThreshold": 5
    }
  },

  "stats": {
    "totalConsultations": 12,
    "totalItemsReported": 47,
    "totalItemsPushedToUser": 15,
    "totalLlmCalls": 89,
    "totalTokensUsed": 245000,
    "totalCostUsd": 0.18,
    "crashCount": 0,
    "uptimeSince": "2026-03-25T08:00:00Z"
  },

  "config": {
    "ARXIV_CATEGORIES": "cs.AI,cs.CL,cs.MA",
    "ARXIV_KEYWORDS": "agent,multi-agent,LLM,reasoning"
  }
}
```

---

## 4. workspace/STATUS.md Format

The tentacle must update this file after each daemon cycle:

```markdown
# {Tentacle Display Name} — Runtime Status

## Current Status
- **Running status:** Running normally
- **Last engineering layer execution:** 2026-03-26 16:00 UTC (success)
- **Last Agent activation:** 2026-03-26 14:30 UTC
- **Last report to Brain:** 2026-03-26 14:30 UTC (pushed 2 papers)
- **Current pending report queue:** 2 items (threshold 5)

## Statistics
- Total scanned: 1,247
- Passed rule filtering: 189
- Retained after Agent deep read: 47
- Reported to Brain: 47
- Pushed to user by Brain: 15

## Database Status
- Recorded IDs: 1,247 entries
- Database size: 2.3 MB

## Last Execution Summary
2026-03-26 16:00: Fetched 31 new papers from cs.AI and cs.CL,
rule filtering retained 4 papers, did not reach Agent activation threshold (requires 5), continuing to accumulate.
```

---

## 5. workspace/REPORTS.md Format

Brief summaries of historical reports:

```markdown
# Historical Report Records

## 2026-03-26 14:30 — Consultation #cs-001
- Reported 5 items, Brain pushed 2, discarded 3
- Pushed: Paper A (Multi-Agent Planning), Paper B (Chain-of-Reasoning)
- Brain feedback: Focus more on methodological innovation

## 2026-03-25 20:00 — Consultation #cs-000
- Reported 3 items, Brain pushed 1, discarded 2
- Pushed: Paper C (Efficient Retrieval-Augmented Generation)
```

---

## 6. reports/ Directory Management

### pending/ — Pending Reports

One JSON file per batch, generated by the tentacle Agent layer:

```json
{
  "batch_id": "batch-001",
  "created_at": "2026-03-26T14:30:00Z",
  "items": [
    {
      "id": "arxiv-2403-12345",
      "title": "Multi-Agent Planning with LLM",
      "summary": "Proposes the MAPLE framework...",
      "judgment": "important",
      "reason": "Directly relevant to the user's OpenCeph project",
      "source_url": "https://arxiv.org/abs/2403.12345",
      "metadata": {}
    }
  ]
}
```

### submitted/ — Submitted Archive

After a consultation ends, merge the pending content with consultation results and archive:

```json
{
  "consultation_id": "cs-uuid-001",
  "submitted_at": "2026-03-26T14:35:00Z",
  "items_count": 5,
  "pushed_count": 2,
  "discarded_count": 3,
  "brain_feedback": "Focus more on methodological innovation",
  "items": [ ... ]
}
```
