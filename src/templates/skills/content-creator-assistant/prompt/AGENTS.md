# Content Creator Assistant — Agent Behavioral Rules

## Material Collection Rules

1. **Source Scanning**
   - Fetch top stories from Hacker News (Algolia API) each collection cycle.
   - Scan each configured source independently; one source failure must not block others.
   - Deduplicate materials by URL before storing; skip already-stored URLs.

2. **Material Storage**
   - All collected materials are persisted to the local SQLite database via `MaterialDB`.
   - Store: `source`, `url`, `title`, `content` (description/summary), `collected_at`.
   - Mark materials as `analyzed=False` on insert; set `analyzed=True` after weekly analysis.

3. **Rate Limiting**
   - Respect public API fair use: max 1 HN collection per cycle.
   - Add 0.5s delay between individual item fetches when enriching content.

## Analysis Rules (Weekly — Mondays)

1. **Trigger Condition**
   - Run analysis every Monday, or when `run_now` directive is received.
   - Analyze all materials with `analyzed=False`.
   - Skip analysis if fewer than 5 unanalyzed materials exist (wait for more to accumulate).

2. **LLM Analysis**
   - Pass all unanalyzed materials to `ContentAnalyzer.analyze_materials()`.
   - The analyzer returns identified content opportunities ranked by potential.
   - For each top opportunity, call `generate_article_outline()` to produce a structured outline.

3. **Article Generation**
   - For each outline, call `ArticleWriter.write_article()` to produce the full draft.
   - Save the draft to `MaterialDB` with `status="draft"`.
   - After saving, immediately trigger the action_confirm report flow.

## action_confirm Flow Rules

1. **Report**
   - For each generated article draft, send one `consultation_request` with `mode: "action_confirm"`.
   - Never batch multiple article drafts into a single action_confirm request.
   - Include `article_id` in the action payload so the directive handler can identify which
     article was approved or rejected.

2. **Waiting State**
   - After sending action_confirm, the tentacle continues its normal schedule (collecting, etc.).
   - Maintain an in-memory dict `pending_approvals: {article_id: article_data}` while waiting.
   - Do not re-report a pending article unless it has been explicitly rejected.

3. **On action_approved**
   - Look up `article_id` in `pending_approvals`.
   - Call `publisher.publish(article)` to publish the article.
   - Update DB: `status="published"`, store `publish_url`.
   - Remove from `pending_approvals`.
   - Send a batch consultation_request reporting the published URL.

4. **On action_rejected**
   - Look up `article_id` in `pending_approvals`.
   - Update DB: `status="rejected"`.
   - Remove from `pending_approvals`.
   - Log the rejection; do not retry.

## Directive Handling

| Directive | Behavior |
|---|---|
| `pause` | Stop scheduled cycles; keep pending_approvals in memory |
| `resume` | Resume scheduled cycles |
| `kill` | Flush any pending status updates, then gracefully exit |
| `run_now` | Execute one collection cycle immediately, then run analysis if Monday or if forced |
| `action_approved` | Publish the article identified by `article_id` in the directive payload |
| `action_rejected` | Mark the article identified by `article_id` as rejected |

## Error Handling

- Network failures: retry up to 3 times with exponential backoff (1s, 2s, 4s).
- LLM API failures: log error, skip the current analysis cycle, retry next scheduled run.
- Feishu API failures: log error, report failure to brain via batch consultation_request,
  do not mark article as published.
- Database errors: log and re-raise; a corrupted DB state must not be silently swallowed.
- Never use `os.system()`, `subprocess.Popen()`, or `eval()`.

## Safety Rules

- Never publish without an explicit `action_approved` directive for that specific `article_id`.
- Never auto-approve after a timeout.
- Never modify or delete materials from the database; only add and update status fields.
- System prompt must be loaded from `prompt/SYSTEM.md` at startup; never hardcode it.
