# Repair Agent — autonomous Control Tower triage (detect → diagnose → propose fix) ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[control-tower]] + [[error-feed-monitoring]] + the supervisable-autonomy north star ([[../operational-rules]] § North star). Box-agent family. The standing, agent-form of the manual Control-Tower triage loop (the 2026-06-22 session).

The Control Tower now *detects* problems (error_events via `recordError`, loop_alerts via the monitor) — but a human still has to investigate each, find the root cause, and author a fix spec. This agent automates that diagnosis layer: **"escalation-triage, but for the Control Tower."** It's the objective-owner loop above the monitor's proxy — the monitor *detects*, the repair agent *diagnoses + proposes the fix*, the owner *approves the build*.

## Trigger — event-driven (on error), NOT a cron
Hook the two places the Control Tower already records a problem (right where it pages owners):
- **`recordError()`** records a **new** `error_events` signature → enqueue a `repair` job for it.
- The monitor opens a **new** `loop_alert` → enqueue a `repair` job for it.
The error appearing *is* the trigger — no polling.

## Its own queue
One `repair` `agent_jobs` per **distinct signature** (deduped exactly like error_events groups), on a concurrency-limited **`repair` lane** on the box. N errors at once → N queued jobs draining a few at a time. Skip-enqueue if: a `repair` job for that signature is already active, OR an **open fix spec already exists** for it (don't re-diagnose/re-spec the same thing).

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
- Record a new `error_events` signature (e.g. a synthetic 500) → a `repair` job enqueues for it (deduped — a second identical error doesn't double-enqueue); the box agent investigates, and within a run either commits a fix spec to main + surfaces "error → proposed fix [[slug]]" OR resolves it as transient with a logged reason.
- A real-bug error → a fix spec appears in `docs/brain/specs/` with owner+parent, surfaced with a Build button; the build is **not** auto-queued (unless the signature is on `REPAIR_AUTOBUILD_KINDS`).
- A foreign-app/noise error on the allow-list → its scoping fix spec auto-queues a build (the one sanctioned auto path).
- An error the agent can't diagnose → surfaced "needs human", no spec, no loop.
- Negative: an already-open fix spec for a signature → no duplicate `repair` job / no duplicate spec.
- The Control Tower shows a `repair` lane tile (idle = green; a stuck repair job → red).

## Phase 1 — trigger + repair lane + investigate/classify/act + surface ⏳
The enqueue hook in `recordError` / alert-open (new signature → `repair` job, deduped); the `repair` box kind + lane + `runRepairJob` (read-only investigate → classify → author-spec-to-main / no-op-resolve / surface-needs-human → report); the surface UI (proposed-fix + Build/Dismiss) on the Control Tower; `REPAIR_AUTOBUILD_KINDS` allow-list (default empty/foreign-noise + monitor-false-positive); register the `repair` lane in the Control Tower. Brain: [[../tables/agent_jobs]] (new `repair` kind) · [[../libraries/control-tower]] · [[error-feed-monitoring]] · [[control-tower]] · [[../recipes/build-box-setup]] (lane) · [[../operational-rules]] (North star).
