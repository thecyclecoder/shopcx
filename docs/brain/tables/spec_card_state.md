# spec_card_state

The live, **instant** project-management mirror the [[../dashboard/roadmap|Roadmap board]] reads DB-first ([[../specs/spec-card-db-companion]]). One row per `(workspace, spec_slug)`. Supersedes + retires the disabled `roadmap-reads-specs-from-git` (the per-request git read that burned the GitHub quota) — this solves the same "instant status" goal from our own DB instead.

**spec-status-db-driven** (2026-06-24, [[../specs/spec-status-db-driven]]) flipped the boundary: status / per-phase status / **Priority:** critical / **Deferred:** parked all live HERE, not in the spec markdown. Six git-committing writers (owner status flip, owner priority/defer, build merge, drift reconciler auto-flip, Ada drift-supervise, verification-bullet writeback) used to commit `docs/brain/specs/{slug}.md` on every mutation → a Vercel-deploy storm of pure metadata churn. They all write this table now (+ an audit row to [[spec_status_history]]) — zero markdown commits, zero deploys, zero GitHub API calls for status.

**Canonical-source rule:** the **markdown stays canonical for spec CONTENT** (title, phase titles, owner, parent, blockedBy, autoBuild, repairSignature, summary, verification). **Status / per-phase status / critical / deferred are DB-only** — high-frequency mutable runtime state. The board reads this row authoritatively via the `getRoadmap(workspaceId)` overlay; the markdown markers (⏳/🚧/✅, `**Deferred:**`, `**Priority:** critical`) survive only as legacy noise until Phase 3's `scripts/strip-spec-status-markers.ts` strips them.

**Workspace-scoped** (the merge evidence + the per-workspace board). RLS: any authenticated user reads; service role does all writes (the writers hold the creds). Read by the board via `createAdminClient()`.

**Primary key:** `id`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK · `gen_random_uuid()` |
| `workspace_id` | `uuid` | FK → `workspaces(id)` on delete cascade |
| `spec_slug` | `text` | the spec this is the state for (`docs/brain/specs/{slug}.md`) |
| `status` | `text` | phase rollup — `planned ｜ in_progress ｜ shipped ｜ rejected` · CHECK-constrained · the board signal |
| `phase_states` | `jsonb` | per-phase status `[{ index, title, status }]` — authoritative · default `[]` |
| `flags` | `jsonb` | board flags: `{ deploy_pending?, blocked?, critical?, deferred? }` · default `{}` · merge-patched on write. spec-status-db-driven Phase 1 added `critical` (the **Priority:** flag) and `deferred` (the parked flag) here — no schema change needed for them. `flags.deferred=true` wins over `status` for display via `effectiveStatusFromState` / `resolveBoardStatus`. |
| `last_merge_sha` | `text?` | the build merge commit SHA that shipped this card — compared to `VERCEL_GIT_COMMIT_SHA` for `deploying` vs `live` |
| `created_at` | `timestamptz` | default `now()` |
| `updated_at` | `timestamptz` | bumped every write · default `now()` |

## Upsert spine

`spec_card_state_ws_slug` — a **unique index** on `(workspace_id, spec_slug)`. All writers go through `upsertCardState` ([[../libraries/spec-card-state]]) with `onConflict: "workspace_id,spec_slug"`: insert on first write, update on repeat. `flags` is **read-modify-write merged** (so a merge's `deploy_pending` doesn't clobber a `blocked` flag); `phase_states` / `last_merge_sha` are only touched when the writer supplies them.

## Writers (all instant, all best-effort)

Every writer goes through `upsertCardState` and additionally appends one row per actual transition to [[spec_status_history]] (audit trail). Best-effort: a failed mirror write never breaks the underlying merge / flip / build path. The daily spec-drift reconcile is the backstop.

- **Build merge** → `markSpecCardMergeShipped` (from [[../libraries/agent-jobs]] `reconcileMergedJobs`): `status` = rollup of `phase_states`, `flags.deploy_pending = true`, `last_merge_sha` = the PR's `merge_commit_sha`. Audit actor `merge:<sha>`.
- **Drift flip** → `markSpecCardStatus` (from [[../libraries/spec-drift]] `reconcileSpecDrift` — both the merge auto-flip and the Control-Tower cron). Audit actor `drift:reconciler`.
- **Owner status flip / one-tap drift flip** → `markSpecCardStatus` (from `/api/roadmap/status`, `/api/roadmap/spec-drift`). Audit actor `owner:<user_id>`.
- **Owner priority / defer** → `markSpecCardCritical` / `markSpecCardDeferred` (from `/api/roadmap/priority`). Sets `flags.critical` / `flags.deferred`. Audit actor `owner:<user_id>`.
- **Ada drift-supervise flip** → `markSpecCardStatus` (from `scripts/builder-worker.ts` `runSpecDriftSupervision`). Audit actor `ada`.
- **spec-blockers** → `markSpecCardBlocked` sets/clears `flags.blocked`.

## Reads

`getSpecCardStates(workspaceId)` → `Record<slug, SpecCardState>`. The brain-roadmap loader overlays this DB state onto every `SpecCard` via the `getRoadmap(workspaceId)` / `getSpec(slug, workspaceId)` helpers — status / `flags.critical` / `flags.deferred` / `phase_states` come from the DB authoritatively. Helpers in [[../libraries/spec-card-state]]:

- `effectiveStatusFromState(state)` — `deferred` if `flags.deferred` is set, else the phase rollup in `status`.
- `resolveBoardStatus(markdownStatus, state)` — DB-first overlay, with `flags.deferred` winning over phase progress.
- `rollupPhaseStatus(phaseStates)` — collapses per-phase states to one overall status (the merge-write uses this).
- `deploymentState(state, markdownStatus, VERCEL_GIT_COMMIT_SHA)` → `"deploying" ｜ "live" ｜ null` — the `shipped · deploying` → `shipped · live` chip (driven by `last_merge_sha`, the actual code deploy — not the status mirror, which no longer triggers deploys).

## Gotchas

- **`flags.deferred` wins over `status` for display.** A `flags.deferred=true` card renders in the Deferred column regardless of phase progress. Un-deferring keeps `status` + `phase_states` intact, so progress resumes from the underlying rollup.
- **DB is the source of truth.** The board reads this row authoritatively; the markdown is content-only. Adding new specs needs a row here (the merge auto-creates one; brand-new files default to `planned` until first write).
- **Audit trail.** Every transition writes to [[spec_status_history]] with `actor` + optional `reason` — what `git log docs/brain/specs/` gave us for free pre-refactor.

## Migration

- `supabase/migrations/20260623130000_spec_card_state.sql` — initial table · apply: `scripts/apply-spec-card-state-migration.ts`
- `supabase/migrations/20260624130000_spec_status_history.sql` — adds [[spec_status_history]] audit table (spec-status-db-driven Phase 1) · apply: `scripts/apply-spec-status-history-migration.ts`
- One-time backfill from markdown: `scripts/backfill-spec-status-from-markdown.ts`
- One-time markdown strip (Phase 3 content migration): `scripts/strip-spec-status-markers.ts`

## Related

[[../specs/spec-card-db-companion]] · [[../specs/spec-status-db-driven]] · [[spec_status_history]] · [[../libraries/spec-card-state]] · [[../libraries/brain-roadmap]] · [[../libraries/agent-jobs]] · [[../libraries/spec-drift]] · [[../dashboard/roadmap]] · [[spec_drift]]
