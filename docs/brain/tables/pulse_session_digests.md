# pulse_session_digests

One row per local Claude Code session on the founder's Mac — the distilled context-reconstitution log that powers the [[../specs/founder-pulse]] read-only surface. Phase 1 of [[../specs/founder-pulse]]. Owner: [[../functions/platform]].

The Phase-2 synthesizer ([[../libraries/pulse]], upcoming) joins these rows against the specs / agent_jobs ledger to write the five lenses that render on `/dashboard/developer/pulse`. The digest is the **evidence layer** the LLM narrative pass cites — no free-floating claims: every rendered lens claim carries a cite back to a session, a spec row, or a commit.

**Ingest is LOCAL.** `scripts/pulse-digest.ts` runs on the founder's Mac only. The build box has no filesystem access to `~/.claude/projects/-Users-admin-Projects-shopcx/` by design — that directory is where the desktop Claude Code app writes its `*.jsonl` transcripts. The founder can wire a Claude Code `Stop` hook to invoke the script after each session (optional; see the `update-config` skill).

**No customer_id.** CLAUDE.md's rule for customer-referenced tables (add a Sonnet data tool) does not apply.

**Owner-only surface.** RLS: workspace-member `SELECT`; service role full access. Writes go through `createAdminClient()` from the local script.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `session_id` | `text` | NOT NULL · the `*.jsonl` basename (Claude Code's stable session id). Same session → same id → the upsert spine |
| `project` | `text?` | the project directory slug — e.g. `-Users-admin-Projects-shopcx` |
| `started_at` | `timestamptz?` | first turn timestamp observed in the jsonl (UTC) |
| `last_activity_at` | `timestamptz?` | most recent turn timestamp (UTC in DB; **rendered in America/Puerto_Rico via `formatAstTimestamp`** — the founder's AST wall clock, no DST) |
| `intent` | `text?` | one-sentence "what this session was trying to accomplish" (from the first human turn) |
| `resume_point` | `text?` | one-sentence "where the founder left off" (from the final turns) |
| `decisions` | `jsonb` | NOT NULL · default `'[]'` · array of `{ summary, cite? }` — 0-5 concrete in-session decisions |
| `threads` | `jsonb` | NOT NULL · default `'[]'` · array of `{ title, status?, cite? }` — 0-5 threads of work touched. `status ∈ open ｜ resolved ｜ noise`; the Phase-2 join flips a thread's status to `resolved` when a matching spec is folded/shipped |
| `refs` | `jsonb` | NOT NULL · default `'[]'` · array of `{ kind, value }` — 0-10 pointers mentioned by name. `kind ∈ spec ｜ brain ｜ file ｜ url ｜ commit ｜ pr ｜ migration` (`migration` added by [[../specs/pulse-session-authored-recaps]] Phase 1) |
| `digest_model` | `text?` | the Anthropic model that produced the digest, the literal `heuristic` when the LLM was unavailable, or the literal `session-authored` when the assistant wrote the digest INSIDE a live session via [[../.claude/skills/recap|/recap]]. **Precedence marker — see "Session-authored precedence" below** |
| `source_mtime_ms` | `bigint?` | mtime of the `.jsonl` at ingest time — the idempotency fingerprint (paired with `source_size_bytes`) |
| `source_size_bytes` | `bigint?` | file size at ingest time — completes the idempotency fingerprint |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `pulse_session_digests_touch_updated_at` trigger |

**Unique:** `(workspace_id, session_id)` — one row per (workspace, session). BOTH writers ([[../.claude/skills/recap|/recap]]'s `scripts/pulse-recap.ts` AND the SessionEnd `scripts/pulse-digest.ts`) upsert on this pair — the session lands in exactly ONE row regardless of which writer got there first.

## Session-authored precedence ([[../specs/pulse-session-authored-recaps]] Phase 2)

Two writers, one row, one rule: **the session-authored row is authoritative — the SessionEnd Haiku ingest MUST NOT clobber it.**

- If `digest_model = 'session-authored'`, the row was written by [[../.claude/skills/recap|/recap]] from inside a live session — the model that already knows the truth. The SessionEnd ingest skips these outright (counted in `IngestResult.skipped_session_authored` — surfaced in the `scripts/pulse-digest.ts` console line).
- If `digest_model` is any other value (a Haiku model id or the literal `heuristic`), the SessionEnd ingest owns the row — the (mtime_ms, size_bytes) fingerprint governs whether to re-distill on the next run.
- A `/recap` re-run in the SAME session overwrites the row in place — the same session-authored writer refreshing its own row is fine.
- Enforcement lives in [[../libraries/pulse-digest]] `ingestProjectDirectory` (read-side; short-circuits before the model call) and `upsertDigestRow` (write-side; the belt-and-suspenders returning `{ ok:false, skipped:'session_authored' }` to close the read-then-write race).

**Indexes:** `pulse_session_digests_workspace_last_activity_idx` on `(workspace_id, last_activity_at desc)` — the /pulse renderer scans "recent sessions first" and the Phase-2 synthesizer prioritizes the last-N sessions when composing the five lenses.

## Triggers

- `pulse_session_digests_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()` so the ledger stays honest without app-layer help.

## Who writes / reads

- **Writer (session-authored):** [[../libraries/pulse-digest]] `upsertDigestRow`, invoked by `scripts/pulse-recap.ts` (the [[../.claude/skills/recap|/recap]] skill's runnable). Runs INSIDE a live session; the assistant distills the digest from its own ground truth and upserts with `digest_model='session-authored'`. Authoritative — the SessionEnd ingest below will not clobber it.
- **Writer (SessionEnd fallback):** [[../libraries/pulse-digest]] `ingestProjectDirectory`, invoked by `scripts/pulse-digest.ts`. Upserts on `(workspace_id, session_id)`; skips a file whose `(mtime_ms, size_bytes)` match the prior row (idempotent — cheap repeat runs) AND skips any session whose current row is session-authored (Phase 2 precedence rule — the counter is `IngestResult.skipped_session_authored`).
- **Reader (Phase 2):** `src/lib/pulse.ts` `buildPulse` (upcoming) reads the last-N digests, joins them against [[specs]] via [[../libraries/specs-table]] `listSpecs` and the `agent_jobs↔specs` join on `spec_slug`, and hands the merged evidence to an LLM narrative pass that writes each of the five lenses with cites.
- **Reader (Phase 3):** `/dashboard/developer/pulse` renders the snapshot; every cite is a superscript link back to the session digest row / spec detail page / commit.

## Gotchas

- **UTC in the DB, AST on the screen.** Session timestamps land as UTC; display normalizes via [[../libraries/pulse-digest]] `formatAstTimestamp` (America/Puerto_Rico, UTC-4, no DST). The bug the founder already hit was a UTC-only render on local session `4e303b13`.
- **`tool_result` blocks are NOT human turns.** The distiller's `extractHumanTurnText` filters `message.role==='user' && content` blocks that are `tool_result` — those are the SDK returning tool output, not the founder speaking. Getting this wrong turns every session's "resume point" into a hex tool-call payload.
- **Skipping unchanged files is `(mtime_ms, size_bytes)` — not a content hash.** Sufficient for the local ingest cadence; a manual `touch` re-processes a file (intentional).
- **The LLM pass is best-effort.** When `ANTHROPIC_API_KEY` is missing or the call fails, [[../libraries/pulse-digest]] `heuristicDigest` seeds intent + resume_point from the first/last turns so a row still lands (never lose a session to a transient outage).

## Migration

`supabase/migrations/20260812120000_pulse_session_digests.sql` — apply with `npx tsx scripts/apply-pulse-session-digests-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy guards). RLS enabled with workspace-member `SELECT` + service-role full access.

## Related

[[workspaces]] · [[specs]] · [[spec_phases]] · [[../libraries/pulse-digest]] · [[../libraries/pulse]] · [[../libraries/specs-table]] · [[../specs/founder-pulse]] · [[../functions/platform]] · [[../goals/ceo-mode]]
