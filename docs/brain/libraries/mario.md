# mario

Mario's M3 SDK — the deterministic "is THIS spec stalled?" decision that fires the once-per-minute detector cron. Two exports: `evaluateStalledSpecs` turns the M1 [[../tables/spec_timecard_events]] ledger + the M2 wait-span vocabulary + every spec's uncleared blockedBy into candidates; `enqueueMarioJob` files one dedupe-guarded `kind='mario'` [[../tables/agent_jobs]] row per candidate. Called from [[../inngest/mario-stall-cron]] every minute; called nowhere else.

## Why this exists

The stall-vs-legit-wait distinction is the whole point of Mario, and it must be a DETERMINISTIC decision — not a Sonnet judgment call. A stall means the pipeline is silent for a reason nobody named (a wedged worker, an unqueued next phase, a missing status transition). A legit wait means someone or something explicitly paused this spec (an uncleared blocker, a needs_input question, an approval gate, a usage wall, a fold-cooldown). Mario's supervisability comes from that determinism: every drop below cites a concrete signal a human can inspect.

The [[../specs/spec-mario-stall-detector-cron-and-thresholds]] spec is explicit about which drops count as legit waits. This SDK implements that discriminator once so the M4 reasoning agent + any future Mario-adjacent code can share it.

## Exports

### `evaluateStalledSpecs(admin, workspace_id?): Promise<StalledCandidate[]>`

Returns EXACTLY the specs whose next lifecycle step is genuinely overdue.

Steps (mirroring the spec's a-e):

1. **Read every `mario_thresholds` row for the workspace.** Each row carries an `sla_ms` for a `(from_event, to_event)` pair — the M4 self-tuner is the only writer.
2. **Per row, call [[./spec-timecards]] `listStalledCandidates(admin, { older_than_ms: sla_ms })`.** Every returned candidate whose `last_event_kind` matches the threshold's `from_event` is a stall against THIS pair (the last event was `from_event`, and `to_event` has not landed within `sla_ms`). A candidate that hits under multiple thresholds surfaces once — first-match wins, threshold-scan order breaks the tie.
   - **Second candidate source — failed/orphaned builds (`readFailedBuildStalls`).** The timecard thresholds only watch happy-path `from → to` transitions, so a build that dies AFTER claiming (orphaned by a worker restart, crashed, or errored) emits no `build_done` event and trips no threshold — and a build that died before the M2 instrumentation went live has NO timecard events at all. This second scan reads the failure straight from `agent_jobs`: a spec whose LATEST `kind='build'` job is `failed` (not superseded by a newer active/completed build) and older than `MARIO_FAILED_BUILD_GRACE_MS` (20 min — past the worker's own orphan-reaper/re-drive window) surfaces as a `build_started → build_done` candidate with `brief.current_job_status='failed'`. Deduped against the timecard candidates, then run through the SAME drops below (a folded / blocked / phantom spec with a stale failed build is still dropped).
3. **The legit-wait discriminator** — the drops:
   - **Uncleared blocker.** [[./brain-roadmap]] `getSpecBlockers(slug)` — any entry with `cleared:false` means the pipeline is intentionally holding this spec behind an upstream one. Drop.
   - **Wait-status on the live job.** The candidate's current active [[../tables/agent_jobs]] row (any status in `ACTIVE_STATUSES`) with a status in `{ blocked_on_dependency, blocked_on_usage, needs_input, needs_approval }` is a paused build. Drop.
   - **Fold-cooldown / deferred override.** The candidate's `specs.status = 'folded'` or `'deferred'` (read straight through [[./specs-table]] `getSpec`) means the spec stopped emitting events on purpose. Drop.
4. **Attach a `MarioBrief` to every survivor.** The brief carries the last 10 timecard events, the `blockedBy` state, and the current job status — the exact payload the M4 reasoning agent needs, JSON-encoded onto `agent_jobs.instructions` by `enqueueMarioJob` so M4 picks it up without another read.

Idempotent (read-only). Safe to call every minute.

### `enqueueMarioJob(admin, candidate): Promise<{ enqueued, job_id?, reason? }>`

Files a `kind='mario'` [[../tables/agent_jobs]] row for a candidate, gated on "no active mario row for this spec_slug already exists".

Contract (from the spec):
- **SELECT first.** `.eq('workspace_id', ...).eq('kind', 'mario').eq('spec_slug', ...).in('status', ACTIVE_STATUSES)` — the workspace + spec + active-status filter proves the row belongs to THIS spec (never a cross-workspace slug collision).
- **If a row exists** → return `{ enqueued: false, reason: 'active_mario_exists' }` (no insert).
- **Re-fire COOLDOWN** (`MARIO_REFIRE_COOLDOWN_MS`, 60 min) → return `{ enqueued: false, reason: 'refire_cooldown' }`. The active-mario dedupe only blocks a CONCURRENT job; the moment a mario job completes with an escalate (or a fix that didn't clear the stall), the stall persists and the next ~1-min sweep re-enqueues — a per-minute Max-session burn on the same spec that the `mario_fixed` loop-guard never catches (escalations are `mario_fired`, not `mario_fixed`). The cooldown suppresses a re-fire when a `mario_fired` row for this spec landed within the window, so Mario looks at a still-stalled spec at most once per hour.
- **Else INSERT.** `agent_jobs { workspace_id, kind: 'mario', status: 'queued', spec_slug, instructions: JSON.stringify(candidate.brief) }`. Returns `{ enqueued: true, job_id }`.

This is app-layer dedupe (SELECT-then-INSERT). Safe under the once-per-minute cron because at most one tick evaluates a given spec at a time. A cross-cron race would insert a second row; M4's own claim step is designed to no-op on that (first-claim-wins).

## Self-service + escalation (applyBoxMario)

- **`reclaim_and_redrive` live-fix** — the built-but-unmerged class (a spec spec-test-approved + security-clean but whose latest build is `failed`/orphaned and never merged). Enqueues a FRESH build via owner-gated `queueRoadmapBuild` (rebases onto current `main` → clean branch → clean merge). Lets Mario self-service reviewing+merging a green PR instead of escalating — routine platform work, not a CEO decision. The worker's `ensureWorktreeSlotFree` frees a `BUILDS_DIR`-pinned branch first; the ephemeral `/tmp`-pinned edge is the `builder-worktree-self-heal` fix-spec.
- **Escalate → Ada (actionable, not a dead row).** When Mario escalates AND applied no live fix, `applyBoxMario` creates an ACTIONABLE target Ada can fix: a fresh `kind='build'` job for the stuck spec parked `needs_approval` with a `reclaim_stuck_build` pending action (deduped — no target if a build is already in-flight for the spec). Because `build` routes to platform, Ada's `enqueuePlatformDirectorJobs` sweep ([[agents-platform-director]]) picks it up; `reclaim_stuck_build` is in-leash (`error_fix` in `LEASH_ACTION_TYPES`) so she AUTO-APPROVES after her read-only investigation, and on approval the job resumes and **rebuilds the spec on current `main` (clean branch → clean merge) — the build IS the reclaim**. Ada is the reviewer+merger; the CEO is never in the loop for routine platform work. Recorded as `mario_fired.metadata.escalated_to_ada`. This closes the loop: Mario self-services the common built-but-unmerged case (`reclaim_and_redrive`); the residual he can't/shouldn't fix himself he hands to Ada, who actually acts.

### Types

- **`MarioBrief`** — `{ last_events: [{ event_kind, phase_index, actor, at, wait_kind, waiting_on }; ≤10], blocked_by_state: [{ slug, cleared }], current_job_status: string | null }`. The bounded payload M4 picks up.
- **`StalledCandidate`** — `{ workspace_id, spec_slug, from_event, to_event, gap_ms, sla_ms, brief }`. One per surviving candidate.
- **`MarioThreshold`** — `{ workspace_id, from_event, to_event, sla_ms, min_count }`. Mirrors a [[../tables/mario_thresholds]] row.
- **`ACTIVE_MARIO_STATUSES`** — the SDK's dedupe status set. Currently identical to [[./agent-jobs]] `ACTIVE_STATUSES`; inlined so a future widening of `ACTIVE_STATUSES` doesn't silently change Mario's dedupe surface without an intentional edit here.

## Legit-wait discriminator (explicit)

Every drop below is a legit wait, NOT a stall. Mario surfaces only the pipeline silences nobody named.

| Signal | Where read | Why it's a legit wait |
|---|---|---|
| `blockedBy[i].cleared === false` | [[./brain-roadmap]] `getSpecBlockers` | An upstream spec's code isn't on `main` yet; the build pipeline refuses to dispatch until the blocker clears (spec-blockers). The gap is by design. |
| `agent_jobs.status === 'blocked_on_dependency'` | live `agent_jobs` row | The worker parked the build waiting for a Claude-breaker to unblock a dependency (Claude-breaker path). The status transition itself is the "waiting" marker. |
| `agent_jobs.status === 'blocked_on_usage'` | live `agent_jobs` row | Every Max account hit its usage wall ([[./box-multi-account-failover]]); the worker parks the build until reset. Auto-resumes; not a stall. |
| `agent_jobs.status === 'needs_input'` | live `agent_jobs` row | The build asked the CEO a question and is waiting for the answer. |
| `agent_jobs.status === 'needs_approval'` | live `agent_jobs` row | The build proposed a gated action (apply_migration / run_prod_script / …) and is waiting for the CEO's approve. |
| `specs.status === 'folded'` | [[./specs-table]] `getSpec` | A folded spec is archived — every downstream reader knows it stopped emitting events on purpose. |
| `specs.status === 'deferred'` | [[./specs-table]] `getSpec` | The CEO explicitly deferred this spec. The pipeline holds no work here. |

Every OTHER silence (last event was `build_done` and no `phase_shipped` in 30min; a `job_queued` that no worker has claimed in 10min; a `review_started` that never emitted a verdict) is a stall — Mario enqueues a job, M4 investigates.

## Callers

- [[../inngest/mario-stall-cron]] — the once-per-minute cron; iterates workspaces, calls `evaluateStalledSpecs` per workspace, calls `enqueueMarioJob` per candidate, applies a per-tick cap so a massive backlog doesn't overwhelm the mario lane.
- Nowhere else. The SDK is Mario-owned; the M4 self-tuning path (`applyBoxMario` → `widenMarioThreshold`, shipped) writes the thresholds table directly to widen an SLA on a false trigger — that write path does NOT go through the read exports above.

## The mario skill

Mario the box-agent (M4, shipped) reads this SDK's brief off `agent_jobs.instructions` and reasons about the stall through the `.claude/skills/mario/SKILL.md` skill file — the vocabulary + verdict envelope + conservative-default contract the M4 spec's Phase 2 mandates. The runner (`scripts/builder-worker.ts` `runMarioJob`) tells the model `use the mario skill (cwd is the repo root)`; the skill file defines the read-only investigation flow + the five-key non-destructive vocabulary (`redrive_dropped_job`, `unstick_stale_status`, `release_cleared_blocker`, `requeue_unclaimed_job`, `queue_box_restart`) + the `MarioVerdict` JSON envelope + the "on ambiguity, escalate" default. `applyBoxMario` (this file, `src/lib/mario.ts`) is the ONLY mutator — atomic claim-guard + `MARIO_AUTONOMY_MODE` kill-switch + `MARIO_LOOP_GUARD_MAX` loop-guard + the `auto_build` fix-spec author + `widenMarioThreshold` self-tune + a [[../tables/director_activity]] audit row. The whole M1→M5 flow is traced in [[../lifecycles/mario-pipeline-plumbing]]. See [[../../.claude/skills/mario/SKILL.md]].

## Related

[[../functions/platform]] (Mario's org home — reports to Ada under the platform function's charge list; org placement wired in [[../../src/lib/agents/personas.ts]] `PERSONAS['mario']` + [[../../src/lib/control-tower/registry.ts]] `MONITORED_LOOPS`) · [[../../.claude/skills/mario/SKILL.md]] (Phase 2 skill file — Mario's read-only investigation contract + JSON verdict envelope) · [[../lifecycles/mario-pipeline-plumbing]] (end-to-end goal home) · [[../tables/mario_thresholds]] · [[../tables/spec_timecard_events]] · [[./spec-timecards]] · [[./brain-roadmap]] · [[./specs-table]] · [[./agent-jobs]] · [[../inngest/mario-stall-cron]]
