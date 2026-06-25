# Spec-Review agent + the In Review column

**Owner:** [[../functions/platform]] · **Parent:** Platform mandate — every spec is sound before it's built (a quality gate ahead of the build pipeline)
**Priority:** critical

## Problem

Specs go straight from authored → `planned` → built, with nothing checking they're well-formed first. Bad specs reach the builder: mangled phases (fleet-spend-governor showed P1/P2/P1/P2), missing/ wrong owner+parent, missing `**Blocked-by:**`, no DB-companion (a `customer_id` table with no Sonnet data tool), wrong formatting. The builder then wastes lanes on a malformed spec, or ships something half-right.

## Model (CEO design)

A new **`in_review`** status that sits BEFORE `planned`, with its own **In Review** column on the roadmap (first column). Every NEWLY authored spec lands in `in_review`. **HARD STOP: an `in_review` spec can NEVER be built** — the build dispatch refuses it. A **Spec-Review agent** works the in-review queue: it reads each spec, checks the author followed every guideline, and then MOVES it to `planned` or `deferred` based on the spec's own directives (is it needed now, or parked). It can also pull an already-built/weird spec back to fix it (the mangled-phases case).

Column flow: **In Review → Planned / Deferred → (build) → In progress → Shipped.**

## Phases

## Phase 1 — the in_review status + column + hard-stop
- `SpecStatus` gains `"in_review"` (src/lib/brain-roadmap.ts). Roadmap `COLUMNS` gets `{ key: "in_review", label: "In Review" }` as the FIRST column. `resolveBoardStatus`/overlay treat it like any DB status.
- NEW specs default to `in_review` (every authoring path: planner, triage, fix-spec builders, director split/author, Ada/coach). spec_card_state.status = 'in_review' on creation.
- **Build hard-stop:** `queueRoadmapBuild` (src/lib/roadmap-actions.ts) refuses a spec whose status is `in_review` — returns an error ("spec is in review — not yet approved to build"). Belt-and-suspenders: the box dispatch + the director escort/init also skip `in_review` specs.

## Phase 2 — the Spec-Review agent (Vale)
- A new box agent kind `spec-review` (persona: Vale, a meticulous reviewer). **Triggered REACTIVELY + a CRON backstop** (the Remi pattern):
  - **Reactive (primary):** the moment a spec's status transitions INTO `in_review` — from ANY source: a newly authored spec, OR Ada / Bo / the CEO / any worker who notices a spec is off and **moves it to `in_review`** (via the `spec-status` action or a board control) — the worker enqueues a `spec-review` job for Vale. So "spot a weird spec → drop it to In Review → Vale catches it" works for free, and the build hard-stop simultaneously stops anyone from building it until it's cleared.
  - **Cron (backstop):** a periodic sweep enqueues any `in_review` spec that has no live review job (covers a missed reactive trigger / a direct DB edit).
- Each review is a `claude -p` pass (read-only DB + repo) against a CHECKLIST: H1 + content-only (no status markers); exactly one well-formed phase sequence (no duplicate/mangled phases); a real **Owner:** (a functions/ function) + **Parent:** (a mandate or goal milestone); a **Blocked-by:** line iff it has prerequisites; a DB-companion plan if it adds a customer-referenced table (Sonnet data tool); a Verification section.
- Verdict per spec: **approve → planned** (sound + needed now), **defer** (sound but parked — set flags.deferred, status to deferred per the spec's own "not needed now" directive), or **fix** (malformed — author the corrections directly: restructure mangled phases, add the missing owner/parent/blockers, then move to planned). Records a director_activity + a spec_status_history row (actor=spec-review).
- Graded by the grader loop (add a `spec-review` rubric — Vale: "caught real spec defects · correct planned/deferred routing · the fixes it made are sound").

## Phase 3 — review on demand + surface
- The CEO (or Ada) can send a built/weird spec back to `in_review` for Vale to fix (the mangled-phases recovery).
- Board: the In Review card shows Vale's pending review state; fold this spec when shipped.

## Verification
- A newly authored spec appears in the **In Review** column, not Planned. Clicking Build on it is refused.
- Vale reviews it → it moves to Planned (or Deferred) with a recorded rationale; only then can it build.
- A malformed spec (duplicate phases / no owner) → Vale fixes it in-place + moves to Planned.
- The build pipeline keeps flowing (specs don't pile up in In Review — Vale clears them each cadence).
