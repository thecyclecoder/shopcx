# deploy_watches

The **Deploy Guardian's** deploy-watch store ([[../specs/deploy-health-rollback-guardian]] Phase 1). One row per merged deploy: a per-spec `claude/<slug>` squash-merge (Gate A) OR an M5 atomic `goal/<slug>` promotion (`is_atomic`). When the auto-merge gate ([[../libraries/github-pr-resolve]] `autoMergeReadyPrs`) squash-merges a build branch — or `promoteCompleteGoalsToMain` atomically merges a goal branch — (→ a Vercel deploy), Reva ([[../libraries/deploy-guardian]]) opens a watch over a bounded **canary window**: it snapshots the pre-deploy error/loop baseline now, then [[../inngest/deploy-guardian-cron]] evaluates the verdict once the window elapses — attributing only signals that FIRST appear AFTER the deploy timestamp (the correlation gate).

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
| `verdict` | `text` | `pending` (default) ｜ `healthy` ｜ `regressed` ｜ `unsure` ｜ `in_review` · CHECK-constrained. `in_review` is stamped by the cron on a **non-healthy** verdict when it enqueues a Reva `kind='deploy-review'` [[agent_jobs]] session ([[../specs/reva-box-session-causal-rollback]] Phase 1) — the box session decides revert｜keep｜escalate and Phase 3's `applyBoxDeployReview` stamps the final verdict (healthy on keep, regressed on revert, unsure on escalate). The pending-window index (partial on `verdict='pending'`) naturally excludes `in_review`, so a re-tick never double-enqueues. |
| `evaluated_at` | `timestamptz?` | when the cron stamped the verdict |
| `findings` | `jsonb` | what the evaluation saw: `{ newErrorSignatures, newRedLoops, redLoopCount, controlTowerOk }` · default `{}` |
| `is_atomic` | `boolean` | `true` ⇒ guards an **M5 atomic goal→main promotion** (a `goal/<slug>` deploy carrying many specs in one merge). A regression on an atomic watch **escalates** instead of auto-reverting (reverting a whole goal is far costlier than a per-phase revert; a human decides) · default `false` (a per-spec `claude/*` deploy → the auto-revert path) |
| `created_at` | `timestamptz` | default `now()` |

## Indexes

- `deploy_watches_merge_sha_key` — **partial unique** on `(merge_sha) where merge_sha is not null`. The de-dupe spine: a re-run of the auto-merge path for the same squash SHA can't double-open a watch (`openDeployWatch` treats a `23505` as a no-op).
- `deploy_watches_pending_window_idx` — on `(window_ends_at) where verdict = 'pending'`. The cron's "what's due?" read.
- `deploy_watches_ws_created_idx` — on `(workspace_id, created_at desc)`. The per-workspace board/scorecard slice.

## The verdict

Stamped by [[../inngest/deploy-guardian-cron]] once the window elapses (see [[../libraries/deploy-guardian]] `verdictFor` — the findings-derived subset):

- **`healthy`** — no NEW deploy-correlated error signature, no NEW red loop. The deploy is marked good + logged.
- **`regressed`** — a clear deploy-correlated spike: a NEW [[loop_alerts]] going red, OR `≥ DEPLOY_REGRESSION_MIN_SIGNATURES` (default 2) distinct NEW [[error_events]] signatures, OR a single NEW signature recurring `≥ DEPLOY_REGRESSION_MIN_COUNT` (default 3) times in the window.
- **`unsure`** — one NEW low-count signature — ambiguous, could be foreign transient noise.

And one lifecycle-only state the cron stamps on a NON-healthy verdict (never returned by `verdictFor` — see [[../specs/reva-box-session-causal-rollback]] Phase 1):

- **`in_review`** — the cron enqueued a Reva `kind='deploy-review'` [[agent_jobs]] session instead of reverting/escalating directly; the box session reads the merge_sha's diff + judges per-signal causal plausibility and returns `revert｜keep｜escalate`; Phase 3's `applyBoxDeployReview` claims on `verdict='in_review'` and stamps the final verdict.

## Phase 2 — act on the verdict

Once the verdict is computed, [[../libraries/deploy-guardian]] takes ONE of three paths depending on the shape of the deploy + the findings ([[../specs/reva-box-session-causal-rollback]] Phase 1):

- **healthy** → **claim** the watch (`update … where verdict='pending' returning id`) with `verdict='healthy'` + write a `deploy_healthy` [[director_activity]] row (unchanged fast path).
- **ATOMIC goal→main watch** (`is_atomic=true`) with a non-healthy findings verdict → **claim** with `verdict='regressed'`/`'unsure'` + escalate to the CEO (reverting a whole tested goal is far costlier than a per-phase revert — never routed through a per-signal review).
- **Per-spec, non-atomic** with a non-healthy findings verdict — **claim** with `verdict='in_review'` + enqueue exactly one `kind='deploy-review'` [[agent_jobs]] row (spec_slug = the watch slug, instructions = watch id + merge_sha + candidate signals + findings-derived starting verdict). The atomic claim is the enqueue idempotency spine — only the tick that wins routes a Reva session, so a re-tick can't double-enqueue. **Loop-guard pre-check** (`DEPLOY_GUARDIAN_LOOP_GUARD_MAX`): a slug that already hit MAX prior auto-rollbacks is stuck in a rollback-then-reland loop → escalate + halt + do NOT enqueue.
- **Phase 3** (`applyBoxDeployReview`, the only mutator) then claims on `verdict='in_review'` and applies the typed verdict: `revert` → `revertDeployMerge` + escalate + `deploy_rolled_back` activity + `findings.rollback = { status: reverted, revert_sha, prior_rollbacks }`; `keep` → `verdict='healthy'` + `deploy_kept` activity; `escalate` → `verdict='unsure'` + escalate (no revert). The rollback outcome shape is unchanged (`findings.rollback = { status, revert_sha?, reason?, prior_rollbacks? }`, **no new column**), and every acted watch writes a matching [[director_activity]] row.

## Gotchas

- **Only auto-merged `claude/*` deploys get a watch.** `openDeployWatch` resolves the workspace + slug from the branch's `kind='build'` [[agent_jobs]] row; a non-build branch (or a branch with no build job) is a no-op — the watch is scoped to the director's auto-fix path.
- **Outage-window errors are excluded.** The correlation gate filters `outage_correlated = true` [[error_events]] (Claude-down symptoms, not this deploy's regression — [[../specs/agent-outage-resilience]]).
- **Evaluation is idempotent.** The verdict stamp updates `where verdict = 'pending'` and **returns the row** — only the evaluator that wins the claim acts, so a concurrent re-run never double-reverts.

## Migration

`supabase/migrations/20260705170000_deploy_watches.sql` (this table + RLS) · apply: `npx tsx scripts/apply-deploy-watches-migration.ts`. `supabase/migrations/20260730120000_deploy_watches_is_atomic.sql` adds `is_atomic` (spec-goal-branch-pm-flow M5 — apply: `npx tsx scripts/apply-deploy-watches-is-atomic-migration.ts`). `supabase/migrations/20260820120000_deploy_watches_in_review_verdict.sql` extends the `verdict` CHECK to add `in_review` ([[../specs/reva-box-session-causal-rollback]] Phase 1 — the cron stamps `in_review` when it enqueues a Reva deploy-review box-session job instead of reverting/escalating directly; apply: `npx tsx scripts/apply-deploy-watches-in-review-verdict-migration.ts`).

## Related

[[../specs/deploy-health-rollback-guardian]] · [[../libraries/deploy-guardian]] · [[../inngest/deploy-guardian-cron]] · [[../libraries/github-pr-resolve]] · [[error_events]] · [[loop_alerts]] · [[director_activity]] · [[agent_jobs]] · [[../libraries/control-tower]] · [[../lifecycles/spec-goal-branch-pm-flow]]
