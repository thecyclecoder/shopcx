# Spec Blockers — gate a build until its prerequisites ship 🚧

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

## Phase 1 — declare + parse + gate ✅
`Blocked-by` parsing in `parseSpec` (`src/lib/brain-roadmap.ts`, exactly like `**Owner:**`/`**Parent:**`); `blockedBy: { slug, title, status, cleared }[]` on `SpecCard`, resolved against the live spec set in `getRoadmap`/`getSpec` (`resolveBlockedBy` — cleared when the blocking spec's derived status is `shipped` OR it's archived/folded/dangling); the blocker check in `queueRoadmapBuild` (`getSpecBlockers` + `phaseEmoji` → refuses with `{ error: "Blocked by: <slug> (<emoji>), …" }`, status 409, inserts NO job); BuildButton "🔒 Blocked by" chip (each blocker + ✅/⏳/🚧) + disabled Build + tooltip naming what must ship first. `next.config.ts` traces specs into `/api/roadmap/build` so the gate sees blockers in prod. Brain: [[../libraries/brain-roadmap]] · [[../libraries/roadmap-actions]] · [[../dashboard/roadmap]] · [[../project-management]] (document the `Blocked-by` field).

## Phase 2 — auto-queue on unblock ⏳
When the **last blocker clears** (a blocking spec flips to `shipped` — detected in `reconcileMergedJobs` / board load, the same hook [[spec-test-on-ship]] uses), **auto-enqueue** the blocked spec's build (if it has none yet + isn't itself shipped). This turns the chain fully hands-off: merge the prerequisite and the dependent build fires itself — exactly the manual watchers I've been launching, made native. De-duped (one auto-queue per spec) + owner can opt a spec out of auto-build. **Also route the box worker's planner auto-queue (`scripts/builder-worker.ts`) through `queueRoadmapBuild`** so the agent enqueue path honours the same gate (P1 gates only the dashboard + Slack chokepoint; the worker still inserts directly).

## Verification
- In `docs/brain/specs/`, add `**Blocked-by:** [[A]]` under some planned spec B's H1 where A is `planned`/`in_progress`, then open `/dashboard/roadmap` → expect B's card to show a "🔒 Blocked by A ⏳" (or 🚧) chip and a Build button reading **🔒 Blocked** that's **disabled** (tooltip: "Build is blocked — ship first: A").
- With B still blocked, `POST /api/roadmap/build { slug: "B" }` (as the owner) → expect HTTP **409** with `{ error: "Blocked by: A (⏳)" }` and **no** new `agent_jobs` row for B (check `getLatestJobsBySlug` / the box queue).
- Flip A's phases to ✅ (StatusControl, or its build ships) → reload `/dashboard/roadmap` → expect B's chip to show **A ✅**, the Build button to re-enable, and `POST /api/roadmap/build { slug:"B" }` to insert a `queued` job. *(P2: B auto-queues — not in this build.)*
- A spec with **no** `**Blocked-by:**` line (or all blockers shipped/archived) → Build works exactly as before (no chip, enabled button) — no regression.
- Negative: point `**Blocked-by:** [[X]]` at an already-shipped-and-archived (folded) spec or a non-existent slug → expect it treated as **cleared** (✅), Build enabled, `/api/roadmap/build` succeeds — a prereq already on `main` never permanently blocks.
- Same gate from the shared chokepoint: the Slack `/build` for a blocked spec (`slack-home`/`slack-roadmap` → `queueRoadmapBuild`) and the dashboard Build both hit the same gate → same 409 + no job. *(Known gap: the box worker's planner auto-queue (`scripts/builder-worker.ts`) inserts `agent_jobs` directly, not via `queueRoadmapBuild` — routing it through the gate is folded into P2's auto-queue work, see below.)*
