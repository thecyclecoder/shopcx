# Regression Agent — review regressions → dismiss or author a fix spec ✅

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/devops-director]] (a worker the Platform/DevOps Director supervises)
**Blocked-by:** [[approval-routing-engine]]

A worker under the [[platform-director-agent|Platform/DevOps Director]] that does exactly what the human operator has been doing by hand: **review each regression and either dismiss it or author a fix spec** — then the **DevOps Director queues the build** (within its leash). More autonomous than the [[../specs/repair-agent|repair agent]]: it **skips the "propose a fix" step and authors the fix spec directly** (the regression is already a confirmed break, not a hypothesis to pitch).

## What a "regression" is
A thing that **used to work and now doesn't** — distinct from a brand-new error:
- A spec marked **✅ shipped** whose verification no longer holds (a **false-✅ / drift**, caught by [[../specs/spec-test-deep-verification|spec-test verification]] — we hit several this session).
- A **previously-green test / build / type-check** that a recent ship broke.
- A **previously-working feature** that an error-feed signal ties to a recent deploy (regression, not foreign noise).

## The loop (detect → review → dismiss | author → DevOps queues)
1. **Detect** — driven by spec-test verification failing a ✅ spec, a CI/tsc regression vs the last green, or an error correlated to a recent ship. (Reuse [[../specs/spec-test-deep-verification]] + the spec-test agent + [[../specs/repair-agent|error feed]].)
2. **Review** — investigate the regression: what shipped, what broke, why. **Dismiss** if it's transient / foreign / a false-positive / already-fixed (record the reasoning — like the repair agent's dismissals).
3. **Author the fix spec** — if real, the agent **writes `docs/brain/specs/{slug}.md` directly** (the diagnostic: what regressed, the offending change, the fix + verification that the original ✅ holds again). No "propose" intermediate.
4. **Hand to the DevOps Director** — the authored fix routes through the [[approval-routing-engine|inbox]]; the **[[platform-director-agent|DevOps Director queues the build]]** (auto-approve within its leash — a regression fix is low-risk/reversible; a *repeatedly-failing* regression fix → loop-guard escalates to CEO). Until the director is live, the fix routes to the CEO inbox.

## Supervisable (north-star)
The agent **authors + dismisses** (a bounded proxy: "is this a real regression + here's the fix"); the **DevOps Director (objective owner) queues the build** and is graded on whether the fix held. The agent never builds/merges on its own — it authors; the manager disposes. Every detect/dismiss/author action writes a [[../tables/director_activity|`director_activity`]] row (feeds the audit history + board + EOD recap).

## Phase 1 — regression detection + review + direct fix-spec authoring ✅
Shipped. The detector, the review/dismiss path (with recorded reasoning), and direct fix-spec authoring that routes into the inbox for the DevOps Director to queue. Brain: [[../libraries/regression-agent]] · [[../tables/director_activity]] · [[../libraries/director-activity]] · [[../goals/devops-director]] · [[platform-director-agent]] · [[approval-routing-engine]] · [[../specs/repair-agent]] · [[../specs/spec-test-deep-verification]] · [[director-loop-grading]].

**What landed:**
- **Detector** — wired into `scripts/builder-worker.ts` `runSpecTestJob`: an `issues` spec-test run on a shipped spec (a ✅ verification that no longer holds) enqueues a `regression` [[../tables/agent_jobs|agent_jobs]] job via `src/lib/regression-agent.ts` `enqueueRegressionJob`. Reuses `getHumanTestQueue`'s exact regression definition (shipped + unarchived + UNRESOLVED evidence-backed fails). The tsc/CI-regression + ship-correlated detectors reuse the same `enqueueRegressionJob`; the ship-correlated path is left to the [[../specs/repair-agent|repair agent]] to avoid double-handling brand-new errors (negative criterion below).
- **Review** — `runRegressionJob` (box, Max, read-only, web search): reviews the regressed spec + its failing checks → one verdict.
- **Dismiss** — `transient｜foreign｜false-positive｜already-fixed` → recorded reasoning on the job + a `dismissed_regression` [[../tables/director_activity]] row; the signature won't re-surface (dedup).
- **Author direct** — `real-regression` → `authorRegressionFixSpec` commits `docs/brain/specs/{slug}.md` to **main** directly (no "propose" row), then routes via [[../libraries/approval-router]] `resolveApproverLive('platform')`: a live+autonomous director auto-queues the build within its leash; pre-M4 it surfaces for the **CEO inbox** (`needs_approval` + a `regression_build` action). Records `authored_fix`.
- **Loop-guard** — `regressionAuthoredAttempts ≥ 2` for a spec → escalate to CEO (`needs_attention` + `escalated` activity), never infinite re-author.
- **Audit** — every detect/dismiss/author/escalate writes a [[../tables/director_activity]] row (new table + `src/lib/director-activity.ts`).

**Lane:** concurrency-1 `regression` lane (`MAX_REGRESSION`, `REGRESSION_TIMEOUT_MS` 15 min) in the box worker.

## Verification
- **Detector fires.** Apply the migration (`npx tsx scripts/apply-director-activity-migration.ts`), then on the box let spec-test run a ✅ shipped spec whose `## Verification` now has an evidence-backed `fail` (or force one) → expect a new `agent_jobs` row `kind='regression'`, `status='queued'`, `spec_slug='regression:{slug}:{hash}'`, and a `director_activity` row `action_kind='detected_regression'` for that slug.
- **Real regression → direct author + route.** Let the box claim that job → expect (a) a new `docs/brain/specs/{fix-slug}.md` committed **directly to `main`** (no human approving a proposal first — confirm the file exists on `main`), carrying `**Regression-of:** [[{slug}]]` + `**Regression-signature:**`; (b) the job in `needs_approval` with a `regression_build` pending action (pre-M4 CEO inbox, since `function_autonomy` for `platform` is off); (c) a `director_activity` row `action_kind='authored_fix'`. Approve it → expect a `kind='build'` job queued for the fix slug.
- **Dismiss, no re-surface.** A `transient/foreign/false-positive/already-fixed` verdict → expect the regression job `completed` with `instructions.verdict` set, NO new spec file, a `director_activity` row `action_kind='dismissed_regression'` with the reason, and a second spec-test run with the SAME failing check → `enqueueRegressionJob` returns `not enqueued (signature already dismissed …)` (no re-surface).
- **Loop-guard → CEO.** With ≥2 prior authored regression jobs for one spec in the window, claim a fresh regression job for it → expect it goes `needs_attention` ("regression loop-guard → escalated to CEO"), authors NO new spec, and writes a `director_activity` row `action_kind='escalated'`.
- **Director leash (when live).** With `function_autonomy` `platform` `live=true, autonomous=true`, a `real-regression` → expect the build is **auto-queued** (a `kind='build'` job appears with no `needs_approval` pause) and the `authored_fix` activity's `director_function='platform'` (the director queued it within its leash).
- **Negative — not double-handled.** A brand-new feature error (never worked) routed here → the review returns `false-positive` ("brand-new — repair agent's") → dismissed, left to the [[../specs/repair-agent|repair agent]]; no fix spec authored here.
