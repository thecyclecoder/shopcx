# inngest/spec-drift-reconcile

The Control-Tower self-audit backstop for the [[../libraries/spec-drift|Spec-Drift Agent]] (Part B of [[../specs/spec-drift-agent]]). Every ~30 min it runs the per-phase, evidence-gated reconciler over every drift-candidate spec, catching residual drift the merge path missed (box down, a PR merged on GitHub directly, a spec shipped before the agent existed).

**File:** `src/lib/inngest/spec-drift-reconcile.ts` · logic in [[../libraries/spec-drift]] (`runSpecDriftReconciler`)

## Functions

### `spec-drift-reconcile`
- **Trigger:** cron `20,50 * * * *` (every ~30 min, offset from the :00/:15/:30/:45 crons)
- **Concurrency:** `concurrency: [{ limit: 1 }]`, `retries: 1`
- **What it does:** for each build-console workspace (any with an [[../tables/agent_jobs]] row — matches the spec-test cron's reach) calls `runSpecDriftReconciler(workspaceId)`, which reconciles every **candidate** spec (live + not yet `shipped`, plus any with an open [[../tables/spec_drift]] row). Per phase: **auto-flip ✅** when its named code is on `main` AND a build merged for the spec (commit to main); **surface** a `spec_drift` row when code is on main but no merged build is on record; **leave** a phase whose code isn't (fully) on main (genuinely unbuilt). See [[../libraries/spec-drift]] for the evidence model.
- **Built-unstamped self-heal (`heal-built-unstamped` step, repurpose-spec-drift-reconciler Phase 1):** after the multi-workspace sweep, calls [[../libraries/spec-drift]] `healBuiltUnstampedPhases(PM_WORKSPACE_ID)` **scoped to the canonical PM workspace ONLY** (`fdc11e10-…` — this step MUTATES `spec_phases`, so it never iterates workspaces / touches a test workspace, unlike the read-only sweep above). It stamps phases the box already shipped but a backfill left `planned` (detected by a recent `kind ∈ build,fold` job that no-op'd "already merged via #N"), advancing the derived status + writing a `healed_built_unstamped` [[../tables/director_activity]] row per spec. Conservative — only the strong "already-merged" signal qualifies. See [[../libraries/spec-drift]].
- **Self-monitoring:** emits its own `spec-drift-reconcile` heartbeat at the end (`emitCronHeartbeat`), registered in `src/lib/control-tower/registry.ts` so a dead reconciler shows as a stale cron tile. A registered-but-never-firing cron (this function once sat registered with Inngest yet never executed its `20,50 * * * *` schedule → 0 beats ever) is now caught by [[../libraries/control-tower]]'s deploy-surviving **`registered_not_firing`** check (0 beats ever while the watchdog's own oldest beat — `monitorUptimeMs` — exceeds the cron's window), distinct from the deploy-anchored `never_fired` and the never-*registered* [[../libraries/control-tower-self-audit|registration diff]].
- **Returns** `{ workspaces, specsScanned, flipped, surfaced, healedSpecs, healedPhases }`.

## Root fix vs backstop

The **root fix** (Part A) lives in [[../libraries/agent-jobs]] `reconcileMergedJobs` — it calls `reconcileSpecDrift` the moment a build PR merges, so the phase(s) it shipped flip ✅ immediately. This cron is the **backstop** that mops up anything the event missed; if Part A is healthy it rarely flips anything.

## Downstream events sent

_None._ Side effects are commits to `main` (phase-emoji flips, via the GitHub Contents API) + DB writes ([[../tables/spec_drift]]).

## Tables written

- [[../tables/spec_drift]] (open / bump / resolve surfaced drift, via `syncDriftRows`)
- [[../tables/spec_phases]] (built-unstamped self-heal — `stampPhaseShipped` advances `status`→`shipped` + stamps `pr`/`merge_sha`)
- [[../tables/director_activity]] (one `healed_built_unstamped` row per self-healed spec)
- [[../tables/loop_heartbeats]] (its own end-of-run beat)

## Tables read (not written)

- [[../tables/agent_jobs]] (build-console workspaces + merged-build evidence)
- [[../tables/spec_drift]] (open rows → resolution candidates)
- `docs/brain/specs/**` via [[../libraries/brain-roadmap]] (`getRoadmap` / `listArchivedSlugs`) — and GitHub `contents` (spec markdown + code-path existence on `main`)

## Register-or-it's-incomplete

Registered in `src/lib/control-tower/registry.ts` as a `cron` loop (`livenessWindowMs` 90m) — per [[../operational-rules]], a new cron is incomplete without a Control Tower entry + an end-of-run heartbeat.

---

[[../README]] · [[../integrations/inngest]] · [[../specs/spec-drift-agent]] · [[../libraries/spec-drift]] · [[../tables/spec_drift]] · [[../libraries/agent-jobs]] · [[../dashboard/control-tower]] · [[../../CLAUDE]]
