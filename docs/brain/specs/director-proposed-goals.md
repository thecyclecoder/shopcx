# Directors can propose goals (CEO-greenlit) ⏳

**Owner:** [[../functions/platform]] · **Parent:** [[../goals/devops-director]] — extends the Agent Org's [[approval-routing-engine]] + [[../libraries/brain-roadmap]] goal model so a director can PROPOSE a goal the CEO still greenlights
**Found in use 2026-06-24:** the CEO wants directors to be able to make goals (then Pia decomposes them). Today only the CEO greenlights goals — a hard rail on the director leash — and a director can emit a spec card but NOT a goal artifact, so Ada had to paste goal drafts as plain text. This adds a first-class director-PROPOSED goal, keeping the CEO greenlight as the activation gate.

## North star — propose, don't self-activate (the rail stays)

A goal is a top-level company objective; the CEO owns objectives, directors own progress within approved ones ([[../operational-rules]] § North star). So this spec lets a director AUTHOR + SURFACE a goal — it does NOT let a director ACTIVATE one. A director-proposed goal is inert until the CEO greenlights it (mirroring how a director proposes a spec and the CEO approves the build). A director proposes only for ITS OWN function; greenlight is ALWAYS the CEO; a director never greenlights any goal — its own or another's. This is the friction-removal, not the rail-removal.

## Phase 1 — the director-proposed goal artifact + explicit greenlit state ⏳
- Add a real `status` to the goal model: `proposed` (director-authored, awaiting CEO) → `greenlit` (CEO-approved, active) → (existing progress/complete). Replaces the current hack where [[../libraries/brain-roadmap]] `parseGoal` / the escort infer 'already greenlit' from `pct > 0` (the devops-director gotcha) — a `proposed` 0% goal is now unambiguously distinct from an active 0% goal.
- A director authors a `docs/brain/goals/{slug}.md` with `**Owner:** [[../functions/{self}]]`, a `**Proposed-by:** [[../functions/{self}]]` marker, and `**Status:** proposed`. The author surface is the same committer path the spec cards use (no new infra), scoped so a director can only author for its own function.
- It routes to the CEO as an Approval Request via [[approval-routing-engine]] — goals NEVER route to a director for greenlight, even a live+autonomous one (unlike owned approvals, which route to the live director). On greenlight the worker flips `Status: greenlit`; on decline it's archived. Writes a `proposed_goal` [[../tables/director_activity]] row.
- The escort's existing 0%-owned-goal handling ([[../libraries/platform-director]] `escortApprovedGoals`) changes from 'escalate as new-goal' to: a `proposed` goal awaits the CEO (no escort), a `greenlit` 0% goal is ready for decomposition, a `greenlit` in-progress goal is escorted as today. Still never auto-starts.
- Brain: [[../libraries/brain-roadmap]] (`parseGoal` + the `GoalCard.status`), [[approval-routing-engine]], [[../libraries/platform-director]], [[../tables/director_activity]].

### Verification — Phase 1
- A director-authored goal lands as `Status: proposed`, surfaces ONE CEO Approval Request, and stays inactive (the escort does not touch it, Pia does not decompose it) until greenlit. On CEO greenlight it flips to `greenlit`; on decline it's archived. A director cannot author a goal for another function, and cannot greenlight any goal.

## Phase 2 — wire greenlit goals into decomposition + escort ⏳
- On greenlight, the goal is eligible for [[../specs/goal-decomposition-engine|Pia]]'s `kind='plan'` human-gated pass (proposes a milestone→spec tree; still CEO-approved per leaf), and once its first specs land (`pct > 0`) the director's `escortApprovedGoals` carries it — the existing chain, unchanged.
- Surface director-proposed goals on the [[../dashboard/agents|Agents hub]] / roadmap with their proposer + `proposed/greenlit` state, so you see what each director is proposing vs what you've activated.

### Verification — Phase 2
- A greenlit goal can be decomposed by Pia and, once its first approved spec builds, is escorted to completion by its owning director. The hub shows proposer + status.

## Phase 3 — the director's coaching/proposal seat gets a `goal` action type ⏳
- Give the director output (coaching chats + the standing surfaces) a first-class `goal` proposal action alongside `spec` — so a director hands the CEO a ready-to-greenlight goal card instead of plain-text drafts. Closes the asymmetry that today only `spec`/`coaching` exist.

### Verification — Phase 3
- In a director chat, proposing a goal emits a `goal` card the CEO can greenlight in one tap; on approval the worker commits the `proposed` goal artifact from Phase 1.

## Open decision (for the CEO) — propose vs. self-activate
This spec deliberately keeps YOUR greenlight as the activation gate (directors propose, you activate) — preserving the north-star boundary that the CEO owns objectives. The alternative — a director auto-creates AND auto-activates its own goals with no CEO gate — inverts that boundary and is the one thing the architecture says not to automate; I've scoped it OUT by default and recommend against it. If you want a bounded version later (e.g. a live director may auto-activate a goal that is purely internal/reversible and under an already-approved parent goal), that's a separate eyes-open decision, not this spec.