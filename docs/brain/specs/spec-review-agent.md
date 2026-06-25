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
- A new box agent kind `spec-review` (persona: a meticulous reviewer). Cadence: whenever ≥1 spec is `in_review`, a `claude -p` pass (read-only DB + repo) reviews each against a CHECKLIST: H1 + content-only (no status markers); exactly one well-formed phase sequence (no duplicate/mangled phases); a real **Owner:** (a functions/ function) + **Parent:** (a mandate or goal milestone); a **Blocked-by:** line iff it has prerequisites; a DB-companion plan if it adds a customer-referenced table (Sonnet data tool); a Verification section.
- Verdict per spec: **approve → planned** (sound + needed now), **defer** (sound but parked — set flags.deferred, status to deferred per the spec's own "not needed now" directive), or **fix** (malformed — author the corrections directly: restructure mangled phases, add the missing owner/parent/blockers, then move to planned). Records a director_activity + a spec_status_history row (actor=spec-review).
- Graded by the grader loop (add a `spec-review` rubric — Vale: "caught real spec defects · correct planned/deferred routing · the fixes it made are sound").

## Phase 3 — governance: author proposes, Vale checks quality, the DIRECTOR disposes (CEO design)

The pipeline flow: **author creates spec → Spec Review (Vale, quality) → Director (Ada) decides Planned vs Deferred → Build → Security → Test → Fold.** An author only PROPOSES; a director DISPOSES.

- **Author's intended destination (a suggestion, not binding):** every spec-creation surface captures the author's intended destination — `planned` or `deferred` — as a DB flag `spec_card_state.flags.intended_status` (NOT hardcoded markdown). It's a signal for the director, nothing more. (Implement across ALL creation surfaces: planner, triage, fix-spec builders, director split/author, Ada/coach.)
- **Vale narrows to QUALITY ONLY:** `needs_fix` (malformed → fix in place or bounce; stays in_review) or `pass` (well-formed). Vale NO LONGER decides planned/deferred. A Vale-`pass` spec enters the **director-disposition lane**.
- **Ada disposes (autonomous, with an asymmetric check vs the author's suggestion):**
  - suggestion == decision (planned→planned, deferred→deferred): autonomous, apply silently.
  - **UPGRADE** — author suggested `deferred`, Ada wants `planned` (spend build resources the author didn't think were needed now): **GATED — one-click CEO approval.** A 2-button inbox card (Planned / Deferred) + Ada's reason WHY. The spec holds until the CEO picks. (She is spending more than proposed → the CEO confirms.)
  - **DOWNGRADE** — author suggested `planned`, Ada defers it: **AUTONOMOUS — no approval**, but send the CEO a NOTIFICATION: "I moved this to deferred for now — want it built now? [Build now → planned]" + a short note WHY. One-click override to planned.
- **Vale → Ada escalation:** if a spec is genuinely ambiguous on quality, Vale surfaces it; the disposition ambiguity is Ada's call (above), and her own uncertainty escalates to the CEO via the UPGRADE/DOWNGRADE cards.

## Phase 4 — agents can send a spec back to In Review + surface
- Every agent that might spot a malformed/off spec — **Ada** (her `spec-status` action), **Bo** (build), **Vale**, **repair/regression**, the **CEO** (a board control) — gets a one-line mandate note: "if a spec looks malformed/off, flip its status to `in_review` (the DB status, via spec-status / the worker) — do NOT build around it." It's a DB flag, never a markdown marker.
- Board: the In Review card shows Vale's pending review state; the director-disposition card shows Ada's pending Planned/Deferred call. Fold this spec when shipped.

## Verification
- A newly authored spec appears in the **In Review** column, not Planned. Clicking Build on it is refused.
- Vale reviews it → it moves to Planned (or Deferred) with a recorded rationale; only then can it build.
- A malformed spec (duplicate phases / no owner) → Vale fixes it in-place + moves to Planned.
- The build pipeline keeps flowing (specs don't pile up in In Review — Vale clears them each cadence).
