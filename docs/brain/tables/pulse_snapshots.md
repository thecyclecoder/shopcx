# pulse_snapshots

Cached five-lens synthesis of the [[../specs/founder-pulse]] surface — one row per `(workspace_id, subject)`. Phase 2 of [[../specs/founder-pulse]]. Owner: [[../functions/platform]].

The [[../libraries/pulse]] `buildPulse` writer joins [[pulse_session_digests]] (Phase 1) against the [[specs]]/[[spec_phases]] ledger via [[../libraries/specs-table]] `listSpecs` + the `agent_jobs↔specs` join on `spec_slug`, maps the evidence into the five lenses (`whats_working`, `where_you_left_off`, `rabbit_holes`, `next_moves`, `threads_in_flight`), and upserts the result here. The [[../libraries/pulse]] `getPulseSnapshot` reader returns the row to the `/api/developer/pulse` route; the Phase-3 `/dashboard/developer/pulse` page renders it.

**`subject` = who the snapshot is for.** v1 only supports `subject='founder'`; reserved for a future per-role expansion (v2 CFO / Growth surfaces).

**Owner-only surface.** RLS: workspace-member `SELECT`, service-role full access. Writes go through `createAdminClient()` from the API route.

**No customer_id.** CLAUDE.md's rule for customer-referenced tables (add a Sonnet data tool) does not apply.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · ON DELETE CASCADE |
| `subject` | `text` | NOT NULL · default `'founder'` · the recipient the snapshot is written for. Reserved for the v2 per-role split |
| `lenses` | `jsonb` | NOT NULL · default `'{}'` · the five lenses. Shape defined by [[../libraries/pulse]] `PulseLenses` — `{ whats_working[], where_you_left_off[], rabbit_holes[], next_moves[], threads_in_flight[] }`, each entry is `{ claim, cite_ids[] }`. **Every claim carries ≥1 cite_id** — no free-floating assertions |
| `cites` | `jsonb` | NOT NULL · default `'{}'` · the cite table the lenses point at. Shape: `{ [cite_id]: { kind, ref, label } }` where `kind ∈ session ｜ spec ｜ commit ｜ pr ｜ brain ｜ file ｜ url` |
| `synthesized_at` | `timestamptz` | NOT NULL · default `now()` · when the snapshot was computed. The Phase-3 header renders it as `"Synthesized {relative}"` via [[../libraries/pulse-digest]] `formatAstTimestamp` |
| `model` | `text?` | Anthropic model id that produced the narrative pass, or the literal `deterministic` when no LLM ran |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | default `now()` · auto-bumped by `pulse_snapshots_touch_updated_at` trigger |

**Unique:** `(workspace_id, subject)` — one snapshot per (workspace, subject). The `/api/developer/pulse?refresh=1` writer upserts on this pair.

**Indexes:** `pulse_snapshots_workspace_subject_idx` on `(workspace_id, subject)` — the read spine of both the API `GET` and the `?refresh=1` upsert lookup.

## Triggers

- `pulse_snapshots_touch_updated_at` — `BEFORE UPDATE` → bumps `updated_at = now()`.

## Who writes / reads

- **Writer:** `/api/developer/pulse?refresh=1` → [[../libraries/pulse]] `buildPulse` → `persistPulseSnapshot`. Also written on the first `GET` when no cached row exists yet.
- **Reader:** `/api/developer/pulse` (default GET) → [[../libraries/pulse]] `getPulseSnapshot`. The Phase-3 `/dashboard/developer/pulse` page renders whatever the API returns.

## Gotchas

- **Every claim must carry ≥1 cite.** The deterministic synthesizer drops zero-cite claims before the persist; the LLM narrative pass drops claims whose `cite_ids` don't resolve. If a lens ever grows a free-floating assertion, the narrative pass is bypassing the cite gate — look at [[../libraries/pulse]] `narrateWithModel` first.
- **v1 is single-subject.** Only `subject='founder'` is written today; the column is here so v2 can add per-role snapshots without a migration.
- **Timestamps are UTC in the DB.** The Phase-3 render normalizes to America/Puerto_Rico (AST, no DST) via `formatAstTimestamp` — the same helper used for [[pulse_session_digests]].

## Migration

`supabase/migrations/20260812120100_pulse_snapshots.sql` — apply with `npx tsx scripts/apply-pulse-snapshots-migration.ts`. Idempotent (`create table if not exists`, `create or replace function`, policy guards). RLS enabled with workspace-member `SELECT` + service-role full access.

## Related

[[workspaces]] · [[pulse_session_digests]] · [[specs]] · [[spec_phases]] · [[../libraries/pulse]] · [[../libraries/pulse-digest]] · [[../libraries/specs-table]] · [[../specs/founder-pulse]] · [[../functions/platform]] · [[../goals/ceo-mode]]
