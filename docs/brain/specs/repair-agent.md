# Repair Agent — autonomous Control Tower triage (detect → diagnose → propose fix) ✅

**Owner:** [[../functions/platform]] · **Parent:** extends [[control-tower]] + [[error-feed-monitoring]] + the supervisable-autonomy north star ([[../operational-rules]] § North star). Box-agent family. The standing, agent-form of the manual Control-Tower triage loop (the 2026-06-22 session).

The Control Tower now *detects* problems (error_events via `recordError`, loop_alerts via the monitor) — but a human still has to investigate each, find the root cause, and author a fix spec. This agent automates that diagnosis layer: **"escalation-triage, but for the Control Tower."** It's the objective-owner loop above the monitor's proxy — the monitor *detects*, the repair agent *diagnoses + proposes the fix*, the owner *approves the build*.

## Trigger — event-driven (on error), NOT a cron
Hook the two places the Control Tower already records a problem (right where it pages owners):
- **`recordError()`** records a **new** `error_events` signature → enqueue a `repair` job for it.
- The monitor opens a **new** `loop_alert` → enqueue a `repair` job for it.
The error appearing *is* the trigger — no polling.

## Its own queue
One `repair` `agent_jobs` per **distinct signature** (deduped exactly like error_events groups), on a concurrency-limited **`repair` lane** on the box. N errors at once → N queued jobs draining a few at a time. Skip-enqueue if: a `repair` job for that signature is already active, OR an **open fix spec already exists** for it (don't re-diagnose/re-spec the same thing).

**Dedup discipline (shipped follow-on — `repair-agent-dedup`, folded into [[../libraries/repair-agent]] § Dedup discipline):** after the first live run over-produced (8 specs / 6 PRs for ~3 root causes), four guards landed — **root-cause grouping** (sibling signatures → one spec carrying N `Repair-signature:` lines), an **already-fixed skip** (a re-fire of a signature already addressed by a recent spec resolves "pending deploy", no re-diagnosis), **auto-build dedup** (≤1 build per slug), and a **per-cycle cluster cap** (a burst → one `cluster:repair` job).

## The agent (box `claude -p`, read-only investigation)
Per error/alert:
1. **Investigate (READ-ONLY):** pull the signature + sample + the implicated route/cron/function; trace the root cause in the codebase. No prod writes during triage.
2. **Classify:** real bug · monitor false-positive · foreign-app/noise · genuine wait/transient.
3. **Act:**
   - real bug / false-positive / noise → **author a fix spec** (`**Owner:**` + `**Parent:**`, single-phase, scoped to a 30-min build) committed to main (the planner's `putFileMain` path);
   - genuine wait / transient → **resolve the `error_events` row + no-op with a logged reason** (never spec noise);
   - can't confidently diagnose → **surface "needs human"** (never loop).
4. **Report:** a triage line (verdict + spec slug or no-op reason) to the Repair feed / Slack + the Control Tower.

## Autonomy: surface-don't-auto-build (+ a narrow mechanical allow-list)
**Default: the agent authors the fix spec and SURFACES it for one-tap owner Build — it does NOT auto-queue the build.** (North star: the agent optimizes the proxy "clear the error"; auto-spawning code builds from a noisy/flapping feed → many PRs + merge churn + cost = Goodhart. The diagnosis+spec is the high-value low-risk half; *building* writes code / opens PRs / applies migrations / merges — the higher-stakes autonomy [[build-approval-gates]] keeps owner-gated.) The surfaced item is "error X → proposed fix [[spec Y]] · [Build] [Dismiss]" — mirrors escalation-triage (proposes, owner finalizes).
- **Narrow auto-queue allow-list** (`REPAIR_AUTOBUILD_KINDS`, each with a reason): only *known-safe, mechanical, self-evident* classes may auto-queue their build — e.g. **foreign-app-noise → scope the capture**, **monitor false-positive → add a grace**. Anything touching product code stays surface-and-approve. Silence/auto is never the default — an entry on the allow-list carries a justification.

## Guardrails (supervisable autonomy)
- Investigation **read-only**; authors **specs (docs)**, never edits product code directly (the build does, owner-gated).
- **Never** auto-merges, **never** auto-applies a migration. Deduped + bounded queue; an undiagnosable error → surface, don't loop.
- Logs its reasoning (every verdict cites the root cause). Registers **itself** in the Control Tower (a `repair` lane tile) — the repairer is watched too.
- Distinguishes transient/genuine-wait (no-op + resolve) from real bug (spec) — doesn't manufacture specs from noise.

## Verification
- Fire a new `error_events` signature (e.g. `await recordError({source:'supabase', keyParts:['_probe-repair','x'], title:'synthetic repair test'})` from a throwaway script) → expect one `agent_jobs` row `kind='repair'`, `status='queued'`, `spec_slug` = the signature; fire the same signature again → expect **no** second repair job (deduped, `enqueueRepairJob` returns `{enqueued:false, reason:'live repair job exists…'}`).
- On the box with the worker running, that queued repair job → expect it claimed on the `repair` lane (`MAX_REPAIR`, log `claimed repair …`) and driven to one terminal/surfaced state: `needs_approval` (a fix spec authored to main + a `repair_build` `pending_actions` entry), `completed` (transient → the `error_events` row flips `status='resolved'`, or an allow-listed verdict auto-queued a `build` job), or `needs_attention` (needs-human, no spec).
- On `/dashboard/developer/control-tower` (owner) → expect a **Repair feed** section: a `needs_approval` repair shows **error → proposed fix [[slug]]** with a **Build** button + **Dismiss**; a `needs_attention` repair shows a **needs human** note (Dismiss only).
- On the Repair feed, click **Build** (`POST /api/developer/control-tower/repair {jobId, action:'build'}`) → expect the repair job → `completed` and a new `agent_jobs` `kind='build'` row for the authored spec slug (the owner-gated build). Click **Dismiss** → expect the repair job `completed` + the originating `error_events` row `status='resolved'`.
- A `foreign-app-noise` / `monitor-false-positive` verdict (on `REPAIR_AUTOBUILD_KINDS`) → expect its scoping fix spec auto-queues a `build` job WITHOUT surfacing (the one sanctioned auto path); a `real-bug` verdict → expect it surfaces for owner Build and is **not** auto-queued.
- In `src/lib/control-tower/registry.ts` → expect an `agent:repair` agent-kind tile; on the Control Tower it's green when idle and red when a repair job is stuck > 60 min.

## Phase 1 — trigger + repair lane + investigate/classify/act + surface ✅
The enqueue hook in `recordError` / alert-open (new signature → `repair` job, deduped); the `repair` box kind + lane + `runRepairJob` (read-only investigate → classify → author-spec-to-main / no-op-resolve / surface-needs-human → report); the surface UI (proposed-fix + Build/Dismiss) on the Control Tower; `REPAIR_AUTOBUILD_KINDS` allow-list (default empty/foreign-noise + monitor-false-positive); register the `repair` lane in the Control Tower. Brain: [[../tables/agent_jobs]] (new `repair` kind) · [[../libraries/control-tower]] · [[error-feed-monitoring]] · [[control-tower]] · [[../recipes/build-box-setup]] (lane) · [[../operational-rules]] (North star).

**Shipped as:** `src/lib/repair-agent.ts` ([[../libraries/repair-agent]]) — `enqueueRepairJob` (deduped by signature) + `REPAIR_AUTOBUILD_KINDS` (foreign-app-noise + monitor-false-positive, each with a justification) + `getOpenRepairs`. Wired into [[../libraries/control-tower]] `recordError` (new signature) + `runControlTowerMonitor` (newly-opened alert). `scripts/builder-worker.ts` `runRepairJob` on the `MAX_REPAIR` (default 2) lane (read-only investigate → classify → `authorRepairSpec` to main / resolve-transient / surface-needs-human; auto-queue only an allow-listed verdict's build, else surface `repair_build`). Surface UI: the **Repair feed** section on `/dashboard/developer/control-tower` + `getOpenRepairs` in the snapshot route + `POST /api/developer/control-tower/repair` (Build/Dismiss → `queued_resume`). `agent:repair` tile registered in `src/lib/control-tower/registry.ts`.
