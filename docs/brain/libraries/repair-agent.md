# libraries/repair-agent

The queue plumbing + autonomy policy behind the **Repair Agent** box agent ([[../specs/repair-agent]] Phase 1) — "escalation-triage, but for the Control Tower." The Control Tower *detects* problems ([[error_events]] via `recordError`, [[loop_alerts]] via the monitor); this is the objective-owner loop above that proxy — it *diagnoses* the root cause read-only and *proposes* the fix, the owner *approves* the build.

**File:** `src/lib/repair-agent.ts` · the box runner is `scripts/builder-worker.ts` `runRepairJob` (see [[../recipes/build-box-setup]]).

## North star — surface-don't-auto-build

The agent optimizes the bounded proxy "clear the error." Auto-spawning code builds from a noisy/flapping feed (many PRs + merge churn + cost) is the exact Goodhart failure ([[../operational-rules]] § North star). So the diagnosis + fix-spec is the high-value low-risk half the agent does autonomously; **building** (writes code / opens PRs / applies migrations) stays owner-gated ([[../specs/build-approval-gates]]). The DEFAULT authors the fix spec to main and **surfaces** it for one-tap owner Build; only a narrow mechanical allow-list auto-queues.

## Exports

- `type RepairVerdict = "real-bug" | "monitor-false-positive" | "foreign-app-noise" | "transient" | "needs-human"` — the box's per-error verdict (it cites the root cause for each).
- `REPAIR_AUTOBUILD_KINDS: Partial<Record<RepairVerdict, string>>` — the **narrow auto-queue allow-list**: only known-safe, mechanical, *monitor-only* classes may auto-queue their build, each with its justification. Default = `foreign-app-noise` ("scope the capture") + `monitor-false-positive` ("add a grace / tighten the assertion"). `real-bug` (touches product code) is NOT on it — it surfaces for approval. Silence/auto is never the default.
- `isRepairAutobuildKind(verdict)` → is this verdict on the allow-list (so its build may auto-queue)?
- `enqueueRepairJob(admin, { source, signature, title, errorEventId?, loopAlertId? })` → enqueue ONE `repair` [[agent_jobs]] job for a NEW Control Tower problem. Deduped GLOBALLY by signature (errors are global infra) — skipped if a repair job for that signature is already **live** (active OR surfaced: `queued`…`queued_resume` ∪ `needs_attention`). `spec_slug` = the signature; `instructions` = the JSON brief the box loads from. **Best-effort, never throws** (it rides the error path). Workspace resolved from the latest [[agent_jobs]] row (the build queue is single-tenant), falling back to the first workspace.
- `getOpenRepairs(admin, workspaceId)` → `RepairSurfaceItem[]` — READ-ONLY: the open repair items awaiting the owner (jobs in `needs_approval` = a proposed fix spec with a Build button, or `needs_attention` = a needs-human verdict, Dismiss only). Auto-queued + transient-resolved jobs complete silently and never appear here. Drives the Control Tower **Repair feed**.

## Trigger — event-driven (NOT a cron)

The error appearing IS the trigger; `enqueueRepairJob` is called inline at the two places the Control Tower records a NEW problem:
- [[control-tower]] `error-feed.ts` `recordError` — the `!existing` (new signature) branch, right after it pages owners.
- [[control-tower]] `monitor.ts` `runControlTowerMonitor` — right after it inserts a newly-opened [[loop_alerts]] incident (signature `loop:<loop_id>`).

## The box runner (`runRepairJob`)

A `kind='repair'` job runs on its own concurrency-limited lane (`MAX_REPAIR`, default 2) as a top-level `claude -p` on Max (web search on, no `ANTHROPIC_API_KEY`, KEEPS read-only DB/crypto secrets). Per error/alert:
1. **Investigate (READ-ONLY)** — `loadRepairBrief` bakes in the signature + sample (the [[error_events]] row) or the [[loop_alerts]] row; the box traces the implicated route/cron/fn in the working tree. No prod writes.
2. **Classify** — one `RepairVerdict`.
3. **Act:**
   - `real-bug` / `monitor-false-positive` / `foreign-app-noise` → `authorRepairSpec` commits a single-phase fix spec to main (idempotent on slug — recurring failures converge on one spec) with `**Owner:**` + `**Parent:**` (no-orphan). Then: on the allow-list → **auto-queue** a `build` [[agent_jobs]] (the one sanctioned auto path) → `completed`; else → **surface** (`needs_approval` + a `repair_build` `pending_actions` entry carrying the slug).
   - `transient` → no spec; resolve the [[error_events]] row + `completed` with a logged reason.
   - `needs-human` → `needs_attention` with a plain one-line note (no spec, no loop).
4. **Owner action resume** — `POST /api/developer/control-tower/repair` flips the job to `queued_resume` with the `repair_build` action `approved` (Build) or `declined` (Dismiss); the box re-claims it and either queues the feature `build` job (the owner-gate) or resolves the error row.

## Gotchas

- **Dedupe is on the repair job, not a separate table** — `recordError` only enqueues on a NEW signature, so a transient-resolved row that later bumps its `count` never re-triggers; a `needs_attention` (needs-human) item blocks re-enqueue (no loop) until the owner Dismisses it.
- **No migration** — `repair` is a free-text [[agent_jobs]] `kind`; the surfaced fix parks in the existing `pending_actions` jsonb (`type:'repair_build'`, `spec_slug`).
- **The repairer is watched too** — registered as an `agent:repair` agent-kind tile in [[control-tower]] `registry.ts` (idle = green; a stuck repair job → red).

## Callers

`src/lib/control-tower/error-feed.ts` (`recordError`) · `src/lib/control-tower/monitor.ts` (`runControlTowerMonitor`) · `scripts/builder-worker.ts` (`runRepairJob`) · `src/app/api/developer/control-tower/route.ts` (`getOpenRepairs`) · `src/app/api/developer/control-tower/repair/route.ts` (Build/Dismiss).

## Related

[[../specs/repair-agent]] · [[control-tower]] · [[../specs/error-feed-monitoring]] · [[../specs/control-tower]] · [[../specs/build-approval-gates]] · [[migration-fix]] (the gated-fix sibling) · [[../tables/agent_jobs]] · [[../tables/error_events]] · [[../tables/loop_alerts]] · [[../recipes/build-box-setup]] · [[../dashboard/control-tower]] · [[../operational-rules]]
