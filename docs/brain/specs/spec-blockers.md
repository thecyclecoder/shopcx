# Spec Blockers — gate a build until its prerequisites ship ⏳

**Owner:** [[../functions/platform]] · **Parent:** extends [[roadmap-build-console]] + [[build-approval-gates]]. Formalizes the manual "**queue after X merges**" sequencing we've been doing by hand all week (migration-shipping-protection → remove-line → base-price; escalate-to-routine → ai-investigation; spec-test P1 → P2) — and which, when forgotten, caused parallel builds to collide into dirty PRs.

Let a spec declare it's **blocked by** other specs; the system **refuses to queue a build** for it until every blocker has shipped. No more hand-tracked chains, no more two builds editing the same file at once because we forgot one wasn't merged yet.

## Model
- **Spec metadata: `**Blocked-by:** [[spec-a]], [[spec-b]]`** — a new line in the spec header, parsed exactly like the existing `**Owner:**` / `**Parent:**` ([[../libraries/brain-roadmap]] `parseSpec`). Each `[[…]]` resolves to a spec slug.
- **A blocker is "cleared"** when the blocking spec's derived status is **`shipped`** (or it's archived/folded) — i.e. the prerequisite code is on `main`. Unshipped (`planned`/`in_progress`) = still blocking.
- `getRoadmap`/`SpecCard` expose `blockedBy: { slug, title, cleared }[]` so the board + the gate share one source of truth.

## Build gate (the enforcement)
- The **single enqueue chokepoint** — the server action behind `/api/roadmap/build` (`queueRoadmapBuild` in [[../libraries/roadmap-actions]]), which all build triggers (BuildButton, PlanButton, Slack `/build`, the planner) route through — checks blockers **before inserting the `agent_jobs` build row**. If any blocker is uncleared → **refuse** with `{ error: "Blocked by: spec-a (⏳), spec-b (🚧)" }`; no job is created.
- **BuildButton / board:** a blocked spec shows a **"🔒 Blocked by …"** chip listing each blocker + its status; the **Build button is disabled** with a tooltip naming what must ship first. Cleared blockers show ✅.
- **Self/agent enqueues** (the planner queueing leaf specs, a cron, my scripts) hit the same `queueRoadmapBuild` gate — so nothing bypasses it.

## Phase 1 — declare + parse + gate ⏳
`Blocked-by` parsing in `parseSpec`; `blockedBy[]` on `SpecCard`; the blocker check in `queueRoadmapBuild` (refuse to enqueue until cleared); BuildButton "🔒 Blocked by" chip + disabled Build + tooltip. Brain: [[../libraries/brain-roadmap]] · [[../libraries/roadmap-actions]] · [[../dashboard/roadmap]] · [[../project-management]] (document the `Blocked-by` field).

## Phase 2 — auto-queue on unblock ⏳
When the **last blocker clears** (a blocking spec flips to `shipped` — detected in `reconcileMergedJobs` / board load, the same hook [[spec-test-on-ship]] uses), **auto-enqueue** the blocked spec's build (if it has none yet + isn't itself shipped). This turns the chain fully hands-off: merge the prerequisite and the dependent build fires itself — exactly the manual watchers I've been launching, made native. De-duped (one auto-queue per spec) + owner can opt a spec out of auto-build.

## Verification
- Author spec B with `**Blocked-by:** [[A]]` while A is `planned`/`in_progress` → on B's roadmap card, Build is **disabled** with "🔒 Blocked by A (⏳)"; calling `/api/roadmap/build` for B returns the blocked error and inserts **no** `agent_jobs` row.
- Ship A (its phases → ✅) → B's card shows the blocker cleared (✅), Build enabled; (P2) B's build **auto-queues** within a board-load/reconcile cycle.
- A spec with no `Blocked-by` (or all blockers shipped) builds normally — no regression to the existing flow.
- The planner / Slack `/build` / scripts all hit the same gate (a blocked spec can't be queued by any path).
- Negative: a `Blocked-by` pointing at an already-shipped/archived spec is treated as cleared (never permanently blocks).
