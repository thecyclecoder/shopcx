# spec_test_runs

The box **spec-test QA agent**'s report over shipped-but-unverified specs ([[../specs/spec-test-agent]]). One row per run of a `kind='spec-test'` [[agent_jobs]] job (`scripts/builder-worker.ts` → `runSpecTestJob`): the agent reads a shipped spec's `## Verification` checklist, classifies each bullet, runs only the **non-destructive** checks on the box, and records the per-check verdicts + its own **`agent_verdict`** stamp here. **Latest run per `(workspace_id, spec_slug)` wins** on the [[../dashboard/roadmap|Developer → Spec Tests]] page + the board chip. The agent **never** marks a spec verified/archived (owner-only gate) and **never** runs a mutating check.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | → [[workspaces]].id · ON DELETE CASCADE |
| `spec_slug` | `text` | the `docs/brain/specs/{slug}.md` that was tested |
| `agent_job_id` | `uuid?` | → [[agent_jobs]].id (the `spec-test` job that produced this run) · ON DELETE SET NULL |
| `agent_verdict` | `text` | the bot's **stamp** (NOT a verify): `approved` (zero auto-checks failed) ｜ `issues` (an auto-check failed) ｜ `needs_human` (nothing auto-ran / only human checks remain) ｜ `error` (no parseable verdict — see below) · default `needs_human`. Re-derived from `checks` by the worker so it can't lie (empty `checks` can never be `approved`). Plain `text` (no DB CHECK constraint), so `error` needed no migration. |
| `summary` | `jsonb` | `{ auto_pass, auto_fail, needs_human, inconclusive }` counts (match `checks`) · default `{}` |
| `checks` | `jsonb` | `[{ text, verdict: pass｜fail｜needs_human｜inconclusive, category: auto｜needs_human｜inconclusive, evidence, screenshot? }]` — one per `## Verification` bullet, with concrete evidence (SELECT result / HTTP status / `file:line` / `vercel`/`gh` line / browser-check assertions). `screenshot` (optional) is a **BROWSER check's** evidence capture — the storage path in the private `spec-test-evidence` bucket, written by `scripts/spec-test-browser-check.ts` ([[../specs/spec-test-deep-verification]] Phase 1); the Developer page signs it per-render (`signSpecTestScreenshot`) and shows the image inline. · default `[]` |
| `transcript` | `text?` | last ~8 KB of the agent's raw output (debugging) |
| `error` | `text?` | failure reason (no parseable JSON / agent-reported error / worker exception) |
| `run_at` | `timestamptz` | when the run completed · default `now()` |
| `created_at` / `updated_at` | `timestamptz` | |

## The stamp (`agent_verdict`) vs human Verified

`agent_verdict` is a **bounded proxy** — "the automatable, non-destructive checks pass" — surfaced as a distinct **"Agent-tested ✅ / ⚠️ issues"** badge **next to** (never replacing) the owner-only **Verified** state ([[../project-management]] Shipped→Verified gate). It's the CEO→role→tool signal that the bot checked the automatable parts and they hold; the owner then confirms. An **auto-`fail` on a shipped spec is high-signal** (it shipped but fails its own verification = a regression or incomplete build) — surfaced loudly. See the supervisable-autonomy north star in [[../operational-rules]].

## The `error` state (no silent empty runs) — [[../specs/spec-test-json-robustness]]

The `spec-test` skill is contracted to emit **only** the result JSON as its final message (fenced/last, no prose). `runSpecTestJob` extracts it defensively (`extractSpecTestResult`: whole-message → last fenced ```json block → last balanced `{...}` scan, tolerating surrounding prose). If that fails, the worker **re-prompts once** on the same session for *only* the JSON. If it still can't parse — or the agent reports `{"status":"error"}`, or the worker throws — the run is written with **`agent_verdict='error'`**, empty `summary`/`checks`, and the reason in `error`. This is a distinct, **retryable** terminal state — *never* a silent 0-check `approved`/empty row that would read like a clean pass. The Developer → Spec Tests page renders it as **"Run errored — retry"** with the raw output tail (from `transcript`), and **Test now** re-runs it.

## Indexes / RLS

- `spec_test_runs_ws_slug_idx (workspace_id, spec_slug, run_at desc)` (latest-per-spec read) · `spec_test_runs_ws_run_idx (workspace_id, run_at desc)`.
- RLS: `spec_test_runs_select` (workspace members read) · `spec_test_runs_service` (service role all writes). The box worker writes via the service role.

## Who writes / reads

- **Writes:** `scripts/builder-worker.ts` → `runSpecTestJob` (one insert per run).
- **Reads:** `src/lib/spec-test-runs.ts` (`getLatestSpecTestRuns`) → the [[../dashboard/roadmap|Developer → Spec Tests]] page, the roadmap board card chip + Agent-tested stamp, and the spec detail `VerificationCard` per-bullet verdicts.
- **Enqueued by:** the daily [[../inngest/spec-test-cron]] (one job per shipped-but-not-archived spec) + the on-demand **Test now** button (`POST /api/roadmap/spec-test`).

## Migration

`supabase/migrations/20260620120000_spec_test_runs.sql` (apply: `scripts/apply-spec-test-runs-migration.ts`).

## Related

[[../specs/spec-test-agent]] · [[agent_jobs]] · [[../inngest/spec-test-cron]] · [[../dashboard/roadmap]] · [[../recipes/build-box-setup]] · [[../project-management]] · [[../operational-rules]]
