# deploy_watches

The **Deploy Guardian's** deploy-watch store ([[../specs/deploy-health-rollback-guardian]] Phase 1). One row per auto-merged `claude/<slug>` deploy. When the auto-merge gate ([[../libraries/github-pr-resolve]] `autoMergeReadyPrs`) squash-merges a build branch (→ a Vercel deploy), Reva ([[../libraries/deploy-guardian]]) opens a watch over a bounded **canary window**: it snapshots the pre-deploy error/loop baseline now, then [[../inngest/deploy-guardian-cron]] evaluates the verdict once the window elapses — attributing only signals that FIRST appear AFTER the deploy timestamp (the correlation gate).

**Workspace-scoped** (mirrors [[director_activity]]): the watch carries the build-console workspace that owned the build, so its verdict + the [[director_activity]] row it writes land in that workspace's audit history / board / scorecard. RLS: any authenticated user reads; service role does all writes (the admin client bypasses RLS).

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade — the build-console workspace that owned the build |
| `slug` | `text` | the spec slug the merged build shipped (from the branch's `kind='build'` [[agent_jobs]] row) |
| `branch` | `text` | the `claude/<slug>` build branch that auto-merged |
| `pr_number` | `int?` | the merged PR (null if unknown) |
| `merge_sha` | `text?` | the squash-merge commit SHA — the deploy's identity (the de-dupe key) |
| `deployed_at` | `timestamptz` | the deploy timestamp; **only signals first seen AFTER this are attributed** · default `now()` |
| `window_ends_at` | `timestamptz` | `deployed_at + CANARY_WINDOW_MS`; the cron evaluates once `now() >= this` |
| `baseline` | `jsonb` | the PRE-deploy snapshot `{ errorSignatures: string[], openLoopAlertIds: string[] }` — belt-and-suspenders so a pre-existing signal that bumps during the window isn't mis-attributed · default `{}` |
| `verdict` | `text` | `pending` (default) ｜ `healthy` ｜ `regressed` ｜ `unsure` · CHECK-constrained |
| `evaluated_at` | `timestamptz?` | when the cron stamped the verdict |
| `findings` | `jsonb` | what the evaluation saw: `{ newErrorSignatures, newRedLoops, redLoopCount, controlTowerOk }` · default `{}` |
| `created_at` | `timestamptz` | default `now()` |

## Indexes

- `deploy_watches_merge_sha_key` — **partial unique** on `(merge_sha) where merge_sha is not null`. The de-dupe spine: a re-run of the auto-merge path for the same squash SHA can't double-open a watch (`openDeployWatch` treats a `23505` as a no-op).
- `deploy_watches_pending_window_idx` — on `(window_ends_at) where verdict = 'pending'`. The cron's "what's due?" read.
- `deploy_watches_ws_created_idx` — on `(workspace_id, created_at desc)`. The per-workspace board/scorecard slice.

## The verdict

Stamped by [[../inngest/deploy-guardian-cron]] once the window elapses (see [[../libraries/deploy-guardian]] `verdictFor`):

- **`healthy`** — no NEW deploy-correlated error signature, no NEW red loop. The deploy is marked good + logged.
- **`regressed`** — a clear deploy-correlated spike: a NEW [[loop_alerts]] going red, OR `≥ DEPLOY_REGRESSION_MIN_SIGNATURES` (default 2) distinct NEW [[error_events]] signatures, OR a single NEW signature recurring `≥ DEPLOY_REGRESSION_MIN_COUNT` (default 3) times in the window. **Phase 2 auto-reverts on this** (restore known-good) + escalates.
- **`unsure`** — one NEW low-count signature — ambiguous, could be foreign transient noise → escalate, never auto-act.

## Phase 2 — act on the verdict

Once the verdict is stamped, [[../libraries/deploy-guardian]] **claims** the watch atomically (`update … where verdict='pending' returning id`) and acts: `regressed` → `revertDeployMerge` restores known-good (auto-revert of the offending squash via the GitHub git-data API) + an `escalateDiagnosisToCeo` carrying the revert; `unsure` → escalate, never auto-act; a slug stuck in a rollback-then-reland loop trips the loop-guard (STOP + escalate). The rollback outcome is written into `findings.rollback` = `{ status: reverted｜loop_guard｜conflict｜revert_failed, revert_sha?, reason?, prior_rollbacks? }` (**no new column**) alongside a `deploy_rolled_back`/`deploy_regressed` [[director_activity]] row.

## Gotchas

- **Only auto-merged `claude/*` deploys get a watch.** `openDeployWatch` resolves the workspace + slug from the branch's `kind='build'` [[agent_jobs]] row; a non-build branch (or a branch with no build job) is a no-op — the watch is scoped to the director's auto-fix path.
- **Outage-window errors are excluded.** The correlation gate filters `outage_correlated = true` [[error_events]] (Claude-down symptoms, not this deploy's regression — [[../specs/agent-outage-resilience]]).
- **Evaluation is idempotent.** The verdict stamp updates `where verdict = 'pending'` and **returns the row** — only the evaluator that wins the claim acts, so a concurrent re-run never double-reverts.

## Migration

`supabase/migrations/20260705170000_deploy_watches.sql` (this table + RLS) · apply: `npx tsx scripts/apply-deploy-watches-migration.ts`

## Related

[[../specs/deploy-health-rollback-guardian]] · [[../libraries/deploy-guardian]] · [[../inngest/deploy-guardian-cron]] · [[../libraries/github-pr-resolve]] · [[error_events]] · [[loop_alerts]] · [[director_activity]] · [[agent_jobs]] · [[../libraries/control-tower]]
