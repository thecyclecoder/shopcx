# libraries/repair-agent

The queue plumbing + autonomy policy behind the **Repair Agent** box agent ([[../specs/repair-agent]] Phase 1) — "escalation-triage, but for the Control Tower." The Control Tower *detects* problems ([[error_events]] via `recordError`, [[loop_alerts]] via the monitor); this is the objective-owner loop above that proxy — it *diagnoses* the root cause read-only and *proposes* the fix, the owner *approves* the build.

**File:** `src/lib/repair-agent.ts` · the box runner is `scripts/builder-worker.ts` `runRepairJob` (see [[../recipes/build-box-setup]]).

## North star — surface-don't-auto-build

The agent optimizes the bounded proxy "clear the error." Auto-spawning code builds from a noisy/flapping feed (many PRs + merge churn + cost) is the exact Goodhart failure ([[../operational-rules]] § North star). So the diagnosis + fix-spec is the high-value low-risk half the agent does autonomously; **building** (writes code / opens PRs / applies migrations) stays owner-gated ([[../specs/build-approval-gates]]). The DEFAULT authors the fix spec to main and **surfaces** it for one-tap owner Build; only a narrow mechanical allow-list auto-queues.

## Exports

- `type RepairVerdict = "real-bug" | "monitor-false-positive" | "foreign-app-noise" | "transient" | "needs-human"` — the box's per-error verdict (it cites the root cause for each).
- `REPAIR_AUTOBUILD_KINDS: Partial<Record<RepairVerdict, string>>` — the **narrow auto-queue allow-list**: only known-safe, mechanical, *monitor-only* classes may auto-queue their build, each with its justification. Default = `foreign-app-noise` ("scope the capture") + `monitor-false-positive` ("add a grace / tighten the assertion"). `real-bug` (touches product code) is NOT on it — it surfaces for approval. Silence/auto is never the default.
- `isRepairAutobuildKind(verdict)` → is this verdict on the allow-list (so its build may auto-queue)?
- `enqueueRepairJob(admin, { source, signature, title, errorEventId?, loopAlertId? })` → enqueue ONE `repair` [[agent_jobs]] job for a NEW Control Tower problem. Deduped GLOBALLY by signature (errors are global infra) — skipped if a repair job for that signature is already **live** (active OR surfaced: `queued`…`queued_resume` ∪ `needs_attention`). `spec_slug` = the signature; `instructions` = the JSON brief the box loads from. **Best-effort, never throws** (it rides the error path). Workspace resolved from the latest [[agent_jobs]] row (the build queue is single-tenant), falling back to the first workspace. **Per-cycle cluster cap:** if more than `REPAIR_CLUSTER_CAP` (5) live repair jobs were queued inside the burst window (`REPAIR_CLUSTER_WINDOW_MS`, 10 min), further signatures fold into ONE `cluster:repair` job (find-or-append to its `members`) instead of N independent diagnoses.
- **Dedup helpers (repair-agent-dedup):** `rootCauseKey(target, verdict)` → a stable `implicated-file::failure-mode` key that collapses sibling signatures onto one spec; `normalizeImplicatedFile(target)` (lowercase, drop `./`/leading slashes, strip a `:line[:col]` suffix); `parseRepairSpecMeta(markdown)` → `{ rootCause, signatures[] }` parsed from a spec's `**Repair-root-cause:**` / `**Repair-signature:**` marker lines; constants `REPAIR_CLUSTER_CAP`, `REPAIR_CLUSTER_WINDOW_MS`, `REPAIR_CLUSTER_SLUG` (`"cluster:repair"`), `REPAIR_RECENT_FIX_WINDOW_MS` (24h, the "pending deploy" window).
- `getOpenRepairs(admin, workspaceId)` → `RepairSurfaceItem[]` — READ-ONLY: the open repair items awaiting the owner (jobs in `needs_approval` = a proposed fix spec with a Build button, or `needs_attention` = a needs-human verdict, Dismiss only). Auto-queued + transient-resolved jobs complete silently and never appear here. Drives the Control Tower **Repair feed**. The [[platform-director|Platform/DevOps Director]] also reads the **`needs-human`** bucket here to **supervise** Rafa's no-fix calls ([[../specs/director-supervised-repair-dismissal]]) — she adversarially re-checks each and dismisses ONLY what she can independently confirm benign (via the same Dismiss path), escalating a suspected masked real bug instead.
- `getDirectorDismissedRepairs(admin, workspaceId)` → `DirectorDismissedRepairItem[]` — READ-ONLY ([[../specs/director-supervised-repair-dismissal]] Phase 2): the Director's recent (14-day) repair dismissals STILL STANDING — the `dismissed_repair` [[../tables/director_activity]] rows minus any whose `repair_job_id` carries a later `reopened_repair` row (the owner tapped Re-open). Title comes from the dismissal metadata. Surfaced under the Control Tower **Repair feed** as `🛠️ Dismissed by Ada — <reasoning>` with a one-tap **Re-open** (the CEO's override over the supervisor) that re-opens the `error_events` row + re-enqueues Rafa.

## Trigger — event-driven (NOT a cron)

The error appearing IS the trigger; `enqueueRepairJob` is called inline at the two places the Control Tower records a NEW problem:
- [[control-tower]] `error-feed.ts` `recordError` — the `!existing` (new signature) branch, right after it pages owners.
- [[control-tower]] `monitor.ts` `runControlTowerMonitor` — right after it inserts a newly-opened [[loop_alerts]] incident (signature `loop:<loop_id>`).

## The box runner (`runRepairJob`)

A `kind='repair'` job runs on its own concurrency-limited lane (`MAX_REPAIR`, default 2) as a top-level `claude -p` on Max (web search on, no `ANTHROPIC_API_KEY`, KEEPS read-only DB/crypto secrets). Per error/alert:
0. **Already-fixed skip (before diagnosing)** — `findAlreadyAddressing(signature)` reads the dedup ledger (recent `repair` jobs + the `root_cause` / `authored_slug` each persisted onto its own `instructions` JSON). If a prior repair already authored a fix spec for THIS signature within `REPAIR_RECENT_FIX_WINDOW_MS` (24h), the problem is addressed (its build is in-flight or merged-but-not-yet-deployed — the stale-error trap) → resolve the [[error_events]] row "fixed by [[spec]], pending deploy" + `completed`, **no LLM diagnosis**. (The enqueue dedup only blocks *live* same-signature jobs, so a re-fire after the prior COMPLETED lands here.)
1. **Investigate (READ-ONLY)** — `loadRepairBrief` bakes in the signature + sample (the [[error_events]] row) or the [[loop_alerts]] row — or, for a `cluster:repair` job, the batched list of `members`; the box traces the implicated route/cron/fn in the working tree. No prod writes.
2. **Classify** — one `RepairVerdict`.
3. **Act:**
   - `real-bug` / `monitor-false-positive` / `foreign-app-noise` → `groupOrAuthorRepairSpec` commits/groups a single-phase fix spec on main: **root-cause grouping** first — if a sibling repair spec authored in the window covers the SAME `rootCauseKey` (implicated file + failure mode), this signature is *added to it* (one root cause → one spec, N `**Repair-signature:**` lines) rather than authoring a near-duplicate; else author new (stamping `**Repair-root-cause:**`). Same-slug stays idempotent. The job persists `{ root_cause, authored_slug }` to `instructions` (the ledger the next repair reads). Then: on the allow-list → **auto-queue** a `build` [[agent_jobs]] — but only after `hasActiveBuildForSlug` confirms no build for that slug is already live / has an open `claude/<slug>-*` PR (**auto-build dedup: ≤1 build per slug** — the 4-identical-PRs guard); else → **surface** (`needs_approval` + a `repair_build` `pending_actions` entry carrying the slug).
   - `transient` → no spec; resolve the [[error_events]] row + `completed` with a logged reason.
   - `needs-human` → `needs_attention` with a plain one-line note (no spec, no loop).
4. **Owner action resume** — `POST /api/developer/control-tower/repair` flips the job to `queued_resume` with the `repair_build` action `approved` (Build) or `declined` (Dismiss); the box re-claims it and either queues the feature `build` job (the owner-gate — also `hasActiveBuildForSlug`-deduped) or resolves the error row.

## Dedup discipline (repair-agent-dedup)

The first live run (2026-06-22) **over-produced** — 8 specs + 6 PRs for ~3 root causes + 1 real bug. Four guards harden it, all keyed off [[agent_jobs]] (no migration; the `instructions` JSON is the ledger):
- **Root-cause grouping** — `rootCauseKey(target, verdict)` = `implicated-file::failure-mode`. Sibling signatures that share a key collapse onto ONE spec (N `**Repair-signature:**` lines), never N specs.
- **Already-fixed skip** — a re-fire of a signature a prior repair already addressed (spec authored within 24h, build in-flight/merged-but-undeployed) resolves "pending deploy" with no re-diagnosis. Closes the stale-open-error trap (an error recorded before its fix deployed).
- **Auto-build dedup** — `hasActiveBuildForSlug(slug)` (active `build` job OR open `claude/<slug>-*` PR) gates BOTH the auto-queue and owner-Build paths: ≤1 build per slug.
- **Per-cycle cluster cap** — a burst beyond `REPAIR_CLUSTER_CAP` live jobs folds into one `cluster:repair` "investigate this cluster" job (it likely shares a cause), authoring one spec for the shared root cause.

## Gotchas

- **Dedupe is on the repair job, not a separate table** — `recordError` only enqueues on a NEW signature, so a transient-resolved row that later bumps its `count` never re-triggers; a `needs_attention` (needs-human) item blocks re-enqueue (no loop) until the owner Dismisses it.
- **The dedup ledger is the `instructions` JSON** — an authored/grouped repair job persists `{ root_cause, authored_slug }` back onto its row; `groupOrAuthorRepairSpec` + `findAlreadyAddressing` read recent rows in JS (one query, 24h window). Within a single burst, sibling jobs that finish near-simultaneously can race the ledger; same-slug convergence + the cluster cap are the backstops.
- **Spec marker lines are machine-parsed** — `**Repair-root-cause:**` + `**Repair-signature:**` (one per grouped signature) under the metadata line; `parseRepairSpecMeta` reads them. Don't reformat them away.
- **No migration** — `repair` is a free-text [[agent_jobs]] `kind`; the surfaced fix parks in the existing `pending_actions` jsonb (`type:'repair_build'`, `spec_slug`).
- **The repairer is watched too** — registered as an `agent:repair` agent-kind tile in [[control-tower]] `registry.ts` (idle = green; a stuck repair job → red).
- **Outage-aware — don't triage into a dead API** ([[../specs/agent-outage-resilience]] Phase 2, [[claude-health]]): while the Claude-down breaker is tripped, `recordError` does NOT enqueue a repair job (it would just 529 — the repair agent needs Claude to triage) and tags the error `outage_correlated` (a NEW signature is auto-resolved as transient — outage-window 5xx are symptoms, not bugs). Already-queued `repair` jobs park `blocked_on_dependency` on the box and drain on recovery. So a Claude outage no longer spawns N redundant "retry the 5xx" proposals; the genuine gap (a call with no retry) is Phase 1's comprehensive fix, not a per-error churn.

## Callers

`src/lib/control-tower/error-feed.ts` (`recordError`) · `src/lib/control-tower/monitor.ts` (`runControlTowerMonitor`) · `scripts/builder-worker.ts` (`runRepairJob`) · `src/app/api/developer/control-tower/route.ts` (`getOpenRepairs` + `getDirectorDismissedRepairs`) · `src/app/api/developer/control-tower/repair/route.ts` (Build/Dismiss/Re-open).

## Related

[[../specs/repair-agent]] · [[control-tower]] · [[../specs/error-feed-monitoring]] · [[../specs/control-tower]] · [[../specs/build-approval-gates]] · [[migration-fix]] (the gated-fix sibling) · [[../tables/agent_jobs]] · [[../tables/error_events]] · [[../tables/loop_alerts]] · [[../recipes/build-box-setup]] · [[../dashboard/control-tower]] · [[../operational-rules]]
