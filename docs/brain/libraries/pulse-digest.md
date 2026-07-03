# libraries/pulse-digest

LLM-distiller for the founder's local Claude Code session transcripts. Reads every `*.jsonl` under `~/.claude/projects/-Users-admin-Projects-shopcx/` on the founder's Mac, extracts the human turns + terminal actions, calls the Anthropic API (Haiku by default) to distill each session into a `SessionDigest`, and upserts the result into [[../tables/pulse_session_digests]] (idempotent on `session_id`). Phase 1 of [[../specs/founder-pulse]]. Owner: [[../functions/platform]].

**File:** `src/lib/pulse-digest.ts`

## Why

The founder resumes work from a cold context every time they close and reopen Claude Code. Grepping a hundred `*.jsonl` transcripts is not context-reconstitution — it is discovery. This module turns each raw transcript into a compact structured digest (`intent` + `resume_point` + a small set of `decisions` / `threads` / `refs`) so the Phase-2 synthesizer ([[../libraries/pulse]]) can join it against the specs / agent_jobs ledger and write the five lenses that render on `/dashboard/developer/pulse`. Every claim on that page carries a cite back to one of these digests, so the surface stays evidence-anchored.

## Runs LOCAL only

`scripts/pulse-digest.ts` runs on the founder's Mac; the build box has no access to `~/.claude/projects/` by design. Freshness is optional-but-recommended via a Claude Code `Stop` hook (see the `update-config` skill) — Phase 1's machine check does not depend on the hook firing.

## Exports

### `SessionDigest` — interface
Structured shape of one distilled session: `{ intent, resume_point, decisions[], threads[], refs[] }`. Mirrors the [[../tables/pulse_session_digests]] columns.

### `DigestRow` — interface
`SessionDigest` + the columnar fields the upserter writes: `session_id`, `project`, `started_at`, `last_activity_at`, `digest_model`, `source_mtime_ms`, `source_size_bytes`.

### `IngestResult` — interface
Per-run counters: `{ scanned, distilled, skipped_unchanged, upserted, errors[] }`.

### `extractHumanTurnText(row: unknown): string | null`
Returns the plain text of a human turn from a parsed jsonl row, or null when the row is not a human turn. **A row counts as human only when `message.role === 'user'` AND no content block is a `tool_result`** — `tool_result` rows are the SDK returning tool output, not the founder speaking. Getting this wrong turns every "resume point" into a hex tool-call payload.

### `extractTimestamp(row: unknown): string | null`
Best-effort extraction of the row's ISO timestamp.

### `parseSessionFile(text: string): { turns, firstAt, lastAt }`
Parses a jsonl file's contents into an ordered list of human turns + boundary timestamps. Malformed lines are silently skipped (an in-flight file often has a partial tail).

### `shapeTurnsForModel(turns, cap = 40): { head, middle, tail }`
Trims a raw turn list to a shape the model can chew — first turn (intent anchor), last 4 turns (resume-point anchor), and a uniform-stride sample of the middle so decisions from a long session aren't lost.

### `distillWithModel(shaped, model = HAIKU_MODEL): { digest, usage } | null`
Calls `https://api.anthropic.com/v1/messages`, JSON-only, `max_tokens: 1200`. Returns `null` on any API failure so the caller falls back to `heuristicDigest` — never lose a session to a transient outage.

### `normalizeDigest(raw): SessionDigest`
Coerces a parsed model response into a valid digest. Drops malformed decisions/threads/refs; clamps arrays to their caps (5/5/10).

### `heuristicDigest(turns): SessionDigest`
Model-free fallback: first turn → `intent`, last turn → `resume_point`, empty arrays. Always returns a valid digest so an upsert can proceed.

### `digestSessionFile({ filepath, session_id, project, model? }): DigestRow | null`
End-to-end for one file: `parseSessionFile` → `shapeTurnsForModel` → `distillWithModel` (falling back to `heuristicDigest`). Returns null when the file has zero human turns.

### `upsertDigestRow(admin, workspaceId, row): void`
`.upsert` on `pulse_session_digests` with `onConflict: 'workspace_id,session_id'`.

### `logDigestUsage(workspaceId, model, usage): void`
Thin wrapper around [[ai-usage]] `logAiUsage` with `purpose: 'pulse_digest'` so cost tracking attributes the pulse ingest separately from the customer-facing paths. Best-effort — never throws.

### `ingestProjectDirectory({ workspaceId, projectDir, project, model?, admin? }): IngestResult`
The one-call entrypoint the runnable script uses. Reads every `*.jsonl` under `projectDir`, skips files whose `(mtime_ms, size_bytes)` match the prior row (the idempotency fingerprint), digests + upserts the rest, and never throws on a single-file failure — the founder shouldn't lose a whole ingest because one transcript has bad JSON on the tail.

### `formatAstTimestamp(iso: string | null): string`
Renders a UTC ISO in America/Puerto_Rico (AST, UTC-4, **no DST**). The single-source renderer the Phase-3 `/pulse` page uses so display never drifts from the ingest normalization. **The bug the founder already hit was a UTC-only render on local session `4e303b13`** — this helper is the fix.

## Callers

- `scripts/pulse-digest.ts` (the local runnable)
- `src/lib/pulse.ts` (Phase 2, upcoming — the synthesizer reads the digests it produces)

## Gotchas

- **`tool_result` blocks aren't human turns.** Filter them in `extractHumanTurnText` or every session's "resume point" becomes a tool-call payload.
- **UTC in the DB, AST on the screen.** Always render through `formatAstTimestamp`, not `Date#toLocaleString` with the browser default zone — the founder is in AST, no DST.
- **Idempotency is `(mtime_ms, size_bytes)`, not a hash.** Sufficient for local cadence; a `touch` re-processes intentionally.
- **API-key absence is not an error.** When `ANTHROPIC_API_KEY` is missing (a dev running the ingest without secrets), `distillWithModel` returns null and `heuristicDigest` fills in — the row still lands with `digest_model='heuristic'`.
- **Malformed jsonl lines are silently skipped.** In-flight sessions often have a partial last line; if you turn a `try/catch` into a throw here you'll fail an ingest mid-session.

## Related

[[../tables/pulse_session_digests]] · [[../libraries/pulse]] · [[ai-models]] · [[ai-usage]] · [[../specs/founder-pulse]] · [[../functions/platform]] · [[../goals/ceo-mode]]
