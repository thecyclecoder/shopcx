# libraries/roadmap-actions

The owner-gated, server-revalidated mutations behind the roadmap build console, called by the dashboard API routes. The approval logic lives here **once**; there is no second copy. (It was originally extracted so a since-removed Slack front-end could share the same gate.)

**File:** `src/lib/roadmap-actions.ts`

## Why this exists

The dashboard routes (`/api/roadmap/{build,answer,approve}`, `/api/branches/[number]/merge`) used to carry their owner-check + mutation inline. A second (now-removed) Slack front-end needed the *same* logic but was authenticated by a Slack HMAC signature, not a Supabase cookie — so the core moved here as plain `(workspaceId, userId)` functions that any caller invokes. Each function **re-checks the owner gate itself** (`assertOwner`) — the caller's claimed identity is never trusted. This is the security boundary.

## Exports

Every function returns `ActionResult<T>` = `({ ok: true } & T) | { ok: false; status: number; error: string }` so a route maps it straight to `NextResponse` and a Slack handler maps it to an ephemeral.

### `queueRoadmapBuild(workspaceId, userId, { slug, instructions?, verify?, chainPhases? })`
Owner-gated build dispatch. **`chainPhases:true`** ("Build all" — [[../specs/build-all-phases-chain]] Phase 1) reads the spec from `main`, queues the **first ⏳ phase** scoped (`phaseScopedInstructions`, [[agent-jobs]]) with **`chain_phases:true`** so the post-merge step (`reconcileMergedJobs` → `queueNextChainedPhase`) auto-queues the next ⏳ phase on each merge until all ✅; a phaseless spec degrades to a normal whole-spec build, an all-built spec is refused (`409`). An in-flight build for the spec coalesces (`alreadyActive`) rather than stacking. `verify:true` → `enqueue_fold` (coalesced batch fold-build) — but **fold-guard-live-build** first calls `getLiveJobForSlug` ([[agent-jobs]]) and **refuses with `409 "Can't archive — a {kind} build for this spec is still live ({status}). It'll fold once that build finishes."`** (no `pending_folds` row / no `kind='fold'` job) when a non-terminal `build`/`spec-test` job for the slug exists, so the owner's manual verify can't orphan a running build. The owner re-taps once the build is terminal; this mirrors the auto-fold gate's exclusion ([[../specs/auto-ship-pipeline]] Gate B). Otherwise, when a build is already live for the spec the behaviour **branches on `instructions`**: a plain Build tap (no instructions) coalesces → `{ job, alreadyActive:true }` (re-building the whole spec mid-build is pointless); a **Report Issue / scoped fix** (with `instructions`) inserts a **distinct** follow-up `queued` row → `{ job, queuedBehindActive:true }` so the new instructions are **never dropped** (the box serializes per-spec, running it after the active build). With no live build, inserts a fresh `queued` [[../tables/agent_jobs]] row. `instructions` scopes a fix-build (Slack `/bug`, dashboard Report Issue, per-phase build). See [[../specs/fix-report-issue-dropped]].

**Build gate ([[../specs/spec-blockers]]).** Before inserting any build row (but *after* the `verify`/fold branch — folding an already-shipped spec isn't a build), it checks `getSpecBlockers(slug)` ([[brain-roadmap]]): if any blocker is **uncleared** (its prerequisite spec hasn't shipped / been archived), it refuses with `{ ok:false, status:409, error:"Blocked by: <slug> (<emoji>), …" }` and inserts **no job**. This is the single enqueue chokepoint — the dashboard `/api/roadmap/build` routes here, so a blocked spec can't be queued. (Known gap: the box worker's planner auto-queue inserts `agent_jobs` directly, bypassing this — folded into spec-blockers P2.) The [[../dashboard/roadmap|BuildButton]] mirrors the gate client-side: a "🔒 Blocked by …" chip + disabled Build.

**Existing-job guard — `kind='build'` invariant ([[../specs/fix-queue-roadmap-build-kind-filter]]).** The SELECT that decides whether a slug already has a live build filters on the exact tuple `(workspace_id, spec_slug, kind='build', status ∈ ACTIVE_STATUSES)` (`ACTIVE_STATUSES` = the non-terminal set from [[agent-jobs]]). Only a **real `kind='build'` row** counts as a live build; a NON-build [[../tables/agent_jobs]] row for the same slug (e.g. a `kind='mario'` job invoking `reclaim_and_redrive`, or a `kind='spec-test'`, `agent-grade`, `director-grade`, `fold` row) does **NOT** coalesce a fresh build enqueue — the guard falls through and inserts a new `kind='build'` row. Without the `kind='build'` filter the guard matched the Mario job that INVOKED `reclaim_and_redrive` and returned `{alreadyActive:true}` on it — the reclaim silently dropped and the spec sat built-but-unmerged for ~19h (the sol-reads-moved incident). The filter is a compare-and-set guard in the sense of coaching #9/#10 — a plain "any active job for this slug" match is the coarse proxy the fix narrows.

### `answerRoadmapBuild(workspaceId, userId, { jobId, answers })`
Writes `answers` + flips a `needs_input` job to `queued_resume`. 409 if the job isn't awaiting input.

### `approveRoadmapAction(workspaceId, userId, { jobId, actionId, decision })`
Marks one `pending_actions` item approved/declined; flips to `queued_resume` only once **every** action has a decision. 409 if not `needs_approval`.

### `createPrForJob(workspaceId, userId, { jobId })`  *(build-recover-pr-create)*
Recovers a build that **succeeded and pushed its `claude/*` branch** but whose final `gh pr create` failed (transient GitHub error) — the worker flags such a job `needs_attention` with `error="branch pushed but PR creation failed"`. Instead of discarding the completed build via Rebuild, this **opens a PR for the already-pushed branch** against `main` and flips the job → `completed` with the recovered `pr_url`/`pr_number` (clears `error`). **Evidence-gated:** refuses unless `isPrCreateRecoverable(job)` (status `needs_attention` · that exact error · a `claude/*` `spec_branch`) **and** the branch still **exists on origin** (`GET /git/ref/heads/{branch}`) — a genuinely-stuck `needs_attention` (no pushed branch, dirty-resolver human-merge) keeps its human-attention treatment. **Idempotent:** if a PR already exists for the branch it **adopts** it (attaches url/number, `adopted:true`) rather than erroring on a duplicate; also re-checks for an open PR on a create failure (duplicate-PR race). Never pushes code, never touches `main`. Exported alongside `isPrCreateRecoverable` + `PR_CREATE_FAILED_ERROR` (the latter mirrored client-side by [[../dashboard/roadmap|BuildButton]] to offer **Create PR** as the primary action). The worker also retries `ensurePr` a few times with backoff **before** flagging, so this manual recovery is the rare fallback. See [[../specs/build-recover-pr-create]].

### `redriveDeferredBuildOrEscalate(workspaceId, slug, unverifiedReason, sourceJobId)` *(build-completed-with-deferred-pr-must-auto-redrive Phase 1)*

```ts
async function redriveDeferredBuildOrEscalate(
  workspaceId: string,
  slug: string,
  unverifiedReason: string,
  sourceJobId: string,
): Promise<DeferredRedriveOutcome>
```

The **PR-DEFERRED auto-redrive gate**. When a build finishes at the "PR DEFERRED" point (the merge gate's `verifyPhaseAccumulatedOnBranch` reported `complete:false` — one or more phases were stamped built but the branch's actual files don't carry the code), a bare `status='completed'` leaves the spec a silent dead-end: no in-flight row to continue it, no queued row to re-enqueue. This function re-drives a fresh build or escalates to Ada based on two conditions:

1. **Blocker check** — `getSpecBlockers(slug)`. If ANY uncleared blockers remain (a dependency hasn't shipped yet), escalation is FORCED (the blocker must land before a redrive can succeed).
2. **Redrive-count guard** — count prior `redrive_deferred_build` [[../tables/director_activity]] rows for this slug in the last 24h. If ≥ `BUILDER_DEFERRED_REDRIVE_MAX` (env-overridable via `BUILDER_DEFERRED_REDRIVE_MAX`, default 3, mirrors [[../lib/mario.ts]] `MARIO_LOOP_GUARD_MAX`), escalate (the spec has cycled enough times; a human should investigate).

**Outcomes:**
- **`action: "redrive"`** — blockers cleared ∧ redrive count < cap ⇒ enqueue a fresh build via the sanctioned `queueRoadmapBuild` (all safety rails: owner-gated, blocker-gated, active-build-gated). Records `redrive_deferred_build` [[../tables/director_activity]] row for the next invocation's 24h counter.
- **`action: "escalate"`** — blockers uncleared OR redrive cap hit ⇒ create a `needs_approval` [[../tables/agent_jobs]] row (`kind='build'`, `status='needs_approval'`, `instructions='Reclaim spec {slug} — …'`) naming the specific unverified phases (from `unverifiedReason` param) so Ada can investigate. Records `redrive_deferred_build_escalated` row.
- **`action: "skip"`** — another build already in-flight for this spec (a prior surface already redrove or the current build is still resuming) ⇒ de-dupe, no-op.

**De-duped:** checks for any in-flight `kind='build'` row in `ACTIVE_STATUSES` + `needs_approval` before deciding. Never stacks a redundant redrive on a spec that's already rebuilding or awaiting approval.

**Best-effort + idempotent.** Never throws — the caller (a completed build lane) must not fail on an audit blip. A director_activity write error is logged + swallowed. Called from `scripts/builder-worker.ts` at the PR-DEFERRED completion point.

### `mergeClaudePr(workspaceId, userId, prNumber)`
Squash-merges an open `claude/*` PR via the GitHub API, **re-validating** server-side (open · `claude/*` head · `mergeable` · `mergeable_state` clean/behind). Best-effort stamps the originating [[../tables/agent_todos]] `merged_at` + deletes the branch. On a `claude/fold-*` merge it fires the `brain/index.refresh` event so [[../inngest/brain-index-refresh]] regenerates `archive.md` + README counts within minutes.

## Callers

- `src/app/api/roadmap/build/route.ts` · `src/app/api/roadmap/answer/route.ts` · `src/app/api/roadmap/approve/route.ts`
- `src/app/api/branches/[number]/merge/route.ts`

## Gotchas

- **Owner gate is re-checked here, by design.** Each function re-checks `assertOwner` itself — a route's claimed identity is never trusted.
- The build route's GET (job polling) is unchanged — only the POST mutation moved here.

## Related

[[../tables/agent_jobs]] · [[../lifecycles/roadmap-build-console]] · [[../dashboard/roadmap]] · [[../dashboard/branches]]

---

[[../README]] · [[../../CLAUDE]]
