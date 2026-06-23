# Regression Agent — review regressions → dismiss or author a fix spec ⏳

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

## Phase 1 — regression detection + review + direct fix-spec authoring ⏳
The detector (spec-test-✅-now-failing + tsc/CI-regression + ship-correlated error), the review/dismiss path (with recorded reasoning), and direct fix-spec authoring that routes into the inbox for the DevOps Director to queue. Brain: [[../goals/devops-director]] · [[platform-director-agent]] · [[approval-routing-engine]] · [[../specs/repair-agent]] · [[../specs/spec-test-deep-verification]] · [[director-loop-grading]].

## Verification
- A ✅ spec whose verification now fails (a real regression) → the agent reviews, authors `docs/brain/specs/{slug}.md` with the diagnostic + fix, and it lands in the routed inbox; the DevOps Director (or CEO, pre-M4) queues the build → after it merges, the original ✅ verification holds again.
- A transient/foreign/false regression → **dismissed** with recorded reasoning, no spec authored, no re-surface.
- The agent **authors directly** (no separate "propose" row) — confirm the fix spec exists on `main` without a human approving a proposal first.
- Loop-guard: a regression fix that fails to hold after 2 attempts → escalates to CEO (deeper issue), not infinite re-author.
- Negative: a brand-new feature error (not a regression of prior-working behavior) is left to the [[../specs/repair-agent|repair agent]], not double-handled here.
