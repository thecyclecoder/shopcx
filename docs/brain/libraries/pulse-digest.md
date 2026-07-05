# libraries/pulse-digest

LLM-distiller for the founder's local Claude Code session transcripts. Reads every `*.jsonl` under `~/.claude/projects/-Users-admin-Projects-shopcx/` on the founder's Mac, extracts the human turns + terminal actions, calls the Anthropic API (Haiku by default) to distill each session into a `SessionDigest`, and upserts the result into [[../tables/pulse_session_digests]] (idempotent on `session_id`). Phase 1 of [[../specs/founder-pulse]]. Owner: [[../functions/platform]].

**File:** `src/lib/pulse-digest.ts`

## Two writers, one row — session-authored precedence

There are TWO paths that write a `pulse_session_digests` row for a session; both upsert through `upsertDigestRow` on the same `(workspace_id, session_id)` spine so the session gets exactly ONE row.

1. **Session-authored** — the [[../.claude/skills/recap|/recap]] skill (`scripts/pulse-recap.ts`). Runs INSIDE a live Claude Code session; the assistant distills the digest from its own ground truth (what it actually did, decided, and left open), then pipes the JSON to the script which upserts with `digest_model='session-authored'`. This path knows exact PR numbers, exact spec slugs, exact commit shas, exact migration filenames, and each thread's true status — no paraphrase. See [[../specs/pulse-session-authored-recaps]]. Session-id resolution is **deterministic** (`resolveCurrentSession` in `scripts/pulse-recap.ts`): `--session-id` flag → `CLAUDE_CODE_SESSION_ID` env → mtime fallback only when *exactly one* `.jsonl` was touched in the last ~60s; two-or-more refuses with `SessionAmbiguityError`. Fix for the 2026-07-05 misfire that used newest-by-mtime and wrote one session's digest onto a concurrent session's row.
2. **SessionEnd Haiku ingest** — `scripts/pulse-digest.ts` (`ingestProjectDirectory`). Runs AFTER the session on the founder's Mac (wired via a SessionEnd hook); reads the `.jsonl`, extracts human turns, and calls Haiku to distill. Falls back to `heuristicDigest` when the API is unavailable so a row always lands. `digest_model` is the model id (or the literal `heuristic`).

**Precedence rule (Phase 2 of `pulse-session-authored-recaps`, enforced in code):** the SessionEnd ingest MUST NOT overwrite a row whose current `digest_model='session-authored'` — the session-authored row is the authoritative recap for that session; the Haiku ingest is the forget-fallback for sessions that never ran `/recap`. Two-layer guard:

1. **Read-side (primary)** — `ingestProjectDirectory` prefetches `digest_model` alongside `(source_mtime_ms, source_size_bytes)` for every session it's about to touch and short-circuits any session whose current row is session-authored BEFORE distilling (no wasted Haiku round-trip). The count lands in `IngestResult.skipped_session_authored`, and the `scripts/pulse-digest.ts` console line surfaces it.
2. **Write-side (belt-and-suspenders)** — `upsertDigestRow` returns `UpsertDigestRowResult` and, when the incoming `digest_model !== 'session-authored'`, re-reads the current row's `digest_model` and refuses to write if it's `'session-authored'` (returning `{ ok: false, skipped: 'session_authored' }`). This closes the race where a `/recap` upserts BETWEEN the prefetch and the write. Callers must handle the non-`ok` return path (the ingest counts it into `skipped_session_authored`). A same-model overwrite (both current + incoming are session-authored) bypasses the guard so a `/recap` re-run in the SAME session still refreshes.

The SessionEnd hook (`scripts/pulse-digest.ts` invocation) itself is UNCHANGED — it just becomes the forget-fallback for sessions that never ran `/recap`. `(mtime_ms, size_bytes)` idempotency still governs the not-session-authored rows.

**Same shape for both writers.** `SessionDigest.refs[].kind` accepts `spec | brain | file | url | commit | pr | migration`. The session-authored path introduced `migration` (Phase 1 of `pulse-session-authored-recaps`) so a `.sql` filename is a first-class ref, not a stringly-typed `file`. `DIGEST_REF_KINDS` is the single source of truth for validators.

## Why

The founder resumes work from a cold context every time they close and reopen Claude Code. Grepping a hundred `*.jsonl` transcripts is not context-reconstitution — it is discovery. This module turns each raw transcript into a compact structured digest (`intent` + `resume_point` + a small set of `decisions` / `threads` / `refs`) so the Phase-2 synthesizer ([[../libraries/pulse]]) can join it against the specs / agent_jobs ledger and write the five lenses that render on `/dashboard/developer/pulse`. Every claim on that page carries a cite back to one of these digests, so the surface stays evidence-anchored.

## Runs LOCAL only

`scripts/pulse-digest.ts` runs on the founder's Mac; the build box has no access to `~/.claude/projects/` by design. Freshness is optional-but-recommended via a Claude Code `Stop` hook (see the `update-config` skill) — Phase 1's machine check does not depend on the hook firing.

## Exports

### `SessionDigest` — interface
Structured shape of one distilled session: `{ intent, resume_point, decisions[], threads[], refs[] }`. Mirrors the [[../tables/pulse_session_digests]] columns.

### `DigestRef` — interface · `DIGEST_REF_KINDS` — constant · `SESSION_AUTHORED_MODEL` — constant
`DigestRef = { kind, value }`. `kind` ∈ `spec | brain | file | url | commit | pr | migration`; `DIGEST_REF_KINDS` is the exported array of accepted kinds — a single source of truth for validators (`normalizeDigest`, `scripts/pulse-recap.ts`, and any future writer). `migration` was added by the session-authored path (Phase 1 of [[../specs/pulse-session-authored-recaps]]) so a `supabase/migrations/*.sql` filename is a first-class ref rather than being flattened into `file`. `SESSION_AUTHORED_MODEL` is the string literal `'session-authored'` — the marker `upsertDigestRow` and `ingestProjectDirectory` guard on. Import this constant, don't hard-code the literal.

### `DigestRow` — interface
`SessionDigest` + the columnar fields the upserter writes: `session_id`, `project`, `started_at`, `last_activity_at`, `digest_model`, `source_mtime_ms`, `source_size_bytes`.

### `IngestResult` — interface
Per-run counters: `{ scanned, distilled, skipped_unchanged, skipped_session_authored, upserted, errors[] }`. `skipped_session_authored` is the Phase-2 counter — sessions the ingest deliberately did NOT re-distill because their existing row carries the `SESSION_AUTHORED_MODEL` marker; the `scripts/pulse-digest.ts` console line surfaces it so a founder can see the guard firing.

### `UpsertDigestRowResult` — type
`{ ok: true } | { ok: false; skipped: 'session_authored' }`. `upsertDigestRow` returns this so callers can distinguish "wrote the row" from "refused to clobber a session-authored row." The forget-fallback ingest counts a non-`ok` return into `skipped_session_authored`.

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

### `upsertDigestRow(admin, workspaceId, row): UpsertDigestRowResult`
`.upsert` on `pulse_session_digests` with `onConflict: 'workspace_id,session_id'`. **Precedence guard (Phase 2 of [[../specs/pulse-session-authored-recaps]]):** when `row.digest_model !== 'session-authored'`, first re-reads the current row's `digest_model` and refuses to write if it's `'session-authored'` — returning `{ ok: false, skipped: 'session_authored' }` instead of clobbering. Belt-and-suspenders to the primary read-side guard in `ingestProjectDirectory`; also protects any future direct caller that doesn't know the rule. A same-model overwrite (both current + incoming are session-authored) bypasses the guard so a `/recap` re-run in the SAME session still refreshes.

### `logDigestUsage(workspaceId, model, usage): void`
Thin wrapper around [[ai-usage]] `logAiUsage` with `purpose: 'pulse_digest'` so cost tracking attributes the pulse ingest separately from the customer-facing paths. Best-effort — never throws.

### `ingestProjectDirectory({ workspaceId, projectDir, project, model?, admin? }): IngestResult`
The one-call entrypoint the runnable script uses. Reads every `*.jsonl` under `projectDir`, skips files whose `(mtime_ms, size_bytes)` match the prior row (the idempotency fingerprint), digests + upserts the rest, and never throws on a single-file failure — the founder shouldn't lose a whole ingest because one transcript has bad JSON on the tail. **Non-clobbering (Phase 2 of [[../specs/pulse-session-authored-recaps]]):** prefetches `digest_model` alongside the idempotency fingerprint and short-circuits BEFORE distilling any session whose current row is session-authored (no wasted Haiku round-trip); those land in `IngestResult.skipped_session_authored`. The write-side belt-and-suspenders guard in `upsertDigestRow` catches the race where a `/recap` upserts between the prefetch and the write.

### `formatAstTimestamp(iso: string | null): string`
Renders a UTC ISO in America/Puerto_Rico (AST, UTC-4, **no DST**). The single-source renderer the Phase-3 `/pulse` page uses so display never drifts from the ingest normalization. **The bug the founder already hit was a UTC-only render on local session `4e303b13`** — this helper is the fix.

## Callers

- `scripts/pulse-digest.ts` — the SessionEnd Haiku ingest (the forget-fallback)
- `scripts/pulse-recap.ts` — the [[../.claude/skills/recap|/recap]] skill's runnable (session-authored writer). Calls `upsertDigestRow` with `digest_model='session-authored'` and delegates ref-kind normalization to `normalizeDigest`. Owns its own **deterministic session resolver** (`resolveCurrentSession` — `--session-id` flag → `CLAUDE_CODE_SESSION_ID` env → refuse-on-ambiguity mtime) plus `MTIME_LIVE_WINDOW_MS`, `HARNESS_SESSION_ENV`, and `SessionAmbiguityError`. See [[../specs/recap-session-id-resolution]] for the incident and rationale.
- `src/lib/pulse.ts` (Phase 2, upcoming — the synthesizer reads the digests both writers produce)

## Gotchas

- **`tool_result` blocks aren't human turns.** Filter them in `extractHumanTurnText` or every session's "resume point" becomes a tool-call payload.
- **UTC in the DB, AST on the screen.** Always render through `formatAstTimestamp`, not `Date#toLocaleString` with the browser default zone — the founder is in AST, no DST.
- **Idempotency is `(mtime_ms, size_bytes)`, not a hash.** Sufficient for local cadence; a `touch` re-processes intentionally.
- **API-key absence is not an error.** When `ANTHROPIC_API_KEY` is missing (a dev running the ingest without secrets), `distillWithModel` returns null and `heuristicDigest` fills in — the row still lands with `digest_model='heuristic'`.
- **Malformed jsonl lines are silently skipped.** In-flight sessions often have a partial last line; if you turn a `try/catch` into a throw here you'll fail an ingest mid-session.

## Related

[[../tables/pulse_session_digests]] · [[../libraries/pulse]] · [[ai-models]] · [[ai-usage]] · [[../specs/founder-pulse]] · [[../functions/platform]] · [[../goals/ceo-mode]]
