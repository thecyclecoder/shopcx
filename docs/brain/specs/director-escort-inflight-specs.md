# Director escorts in-flight specs, not just goal milestones ⏳

**Owner:** [[../functions/platform]] · **Parent:** hardens [[platform-director-agent]] (M2 escort) — closes a scope gap found in use.

**Found in use 2026-06-23:** the [[platform-director-agent|DevOps Director]] went live + autonomous but didn't pick up obvious work — e.g. `agent-outage-resilience` sitting at **P1✅ P2✅ P3⏳** never got P3 queued. Two root causes: (1) the standing cadence was **daily** (fixed same day → `*/15 * * * *` in [[../inngest/platform-director-cron]]); (2) `escortApprovedGoals` only walks **goal → milestone → linked-spec** trees, so a spec parented to a **function mandate** (not a goal) is invisible to the escort — and with both goals at 100%, the escort had nothing in scope. So a started-but-unfinished standalone spec falls through both the reactive approval path and the goal escort.

**The fix:** the escort must drive two kinds of spec the goal-walk misses, both **inside the existing leash**:
1. **In-flight specs** — ≥1 `## Phase …✅` + remaining `## Phase …⏳`, `chain_phases` — regardless of goal linkage. Continuing started work is the same low-risk "milestone progression" already in the leash.
2. **Authored fix specs at 0 phases** — a spec authored by a repair/regression/db-health worker in response to a **real bug** (signature: a `Verdict: real-bug` / `Repair-root-cause:` header, owner `platform`). Building these IS the director's `error_fix` mandate the CEO already greenlit (e.g. `slack-fetch-timeout-hardening`, `orchestrator-retry-5xx`) — **not** "new work."

**Still escalates to CEO (Phase 3), never auto:** starting a **new FEATURE spec** (a 0-phase spec that is NOT a fix — a product capability) or a **new GOAL**. The 0-phase gate keys on *kind* (fix → build; feature/goal → escalate), not just phase count.

## Phase 1 — sweep + drive in-flight + authored-fix specs ⏳
In [[../libraries/platform-director]], add an `escortInflightSpecs` pass (same standing beat, after `escortApprovedGoals`). Enumerate roadmap specs that are **not blocked** (no unmet `**Blocked-by:**`) and have **no active build/needs_approval job**, and queue work through the EXISTING build chain (auto-queue → builder → auto-ship → fold — never reimplemented):
- **In-flight** (≥1 ✅ phase, ≥1 ⏳): queue the next ⏳ phase (`chain_phases`).
- **0-phase fix spec** (real-bug signature, platform-owned): queue the build (`error_fix` leash, `chain_phases`).
- **0-phase feature/goal spec**: do NOT build — escalate to CEO (Phase 3) as "starting new work."
Dedupe against in-flight/needs_approval jobs for that spec (no double-queue — the race that produced a duplicate `director-loop-grading` build by hand). Log an `escorted_spec` (or `escorted_fix`) `director_activity` row per advance (shows in the EOD recap + board). Brain: [[platform-director-agent]] · [[regression-agent]] · [[../specs/repair-agent]] · [[../lifecycles/project-management]] · [[../inngest/platform-director-cron]].

## Verification
- `agent-outage-resilience` (P1✅/P2✅/P3⏳, no active build) → a pass **queues P3** + logs `escorted_spec`.
- `slack-fetch-timeout-hardening` + `orchestrator-retry-5xx` (0-phase, real-bug, platform) → a pass **queues their builds** (`error_fix`) + logs `escorted_fix` — without a separate human approval.
- A spec already building / needs_approval is **not** re-queued (dedupe holds).
- A **0-phase NON-fix feature** spec is **not** auto-started — it escalates to the CEO (Phase 3 unchanged).
- A spec with an unmet `**Blocked-by:**` is skipped until its blocker ships.
- Goal-linked specs keep flowing through `escortApprovedGoals` unchanged (no regression); the two passes don't double-queue the same spec.
