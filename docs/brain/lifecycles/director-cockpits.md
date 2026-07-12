# Lifecycle: Director cockpits in the Message Center

The **four director cockpits + Eve** — the founder's supervision surface for every director-agent seat in the org chart, unified in one Message Center. Each director gets a first-person coach thread; the leash + M3 dispatch enforce **supervisable autonomy** ([[../operational-rules]] § North star): every in-leash executor auto-runs, every rail hit escalates via `escalateApprovalRequestToCeo`, and every action lands one `director_activity` row named by `director_function`.

Landed under [[../goals/director-chats-in-message-center]] (M1–M5). Marco's read-only seat closed the goal on 2026-07-12 with [[../specs/marco-logistics-director-seat]].

## The directory

| Persona | Function | Where |
|---|---|---|
| **Ada** — Platform / DevOps Director | [[../functions/platform]] | [[../lifecycles/ada-slack-chat]] (Slack + web) · leash: `PLATFORM_LEASH` in [[../libraries/director-leash-guide]] |
| **Max** — Growth Director | [[../functions/growth]] | leash: `GROWTH_LEASH` in [[../libraries/director-leash-guide]] · reallocate / promote / hold cards |
| **June** — CS Director | [[../functions/cs]] | leash: `CS_LEASH` (`approve_remedy` / `author_derived_from_ticket_spec` / `amend_low_blast_sonnet_prompt`) per [[../specs/cs-director-leash-categories]] |
| **Marco** — Logistics Director *(read-only observer)* | [[../functions/logistics]] | leash: `LOGISTICS_LEASH = []` per [[../specs/marco-logistics-director-seat]] Phase 3 — every action escalates to CEO; executor slice queued as [[../specs/marco-logistics-executor-surface]] |
| **Eve** — Executive Assistant *(god-mode cockpit)* | Cross-function EA | [[../lifecycles/god-mode]] — texts with the CEO from the cockpit, gates every risky write on PIN + risk-tier |

## Shared machinery (why the seats plug in without touching each other)

- **Coach threads** — [[../libraries/director-coach-threads]] + [[../tables/director_coach_threads]] · the same table row + turn body every seat uses; `director_function` disambiguates the persona.
- **Leash + guide** — [[../libraries/director-leash-guide]] · `DIRECTOR_LEASH` maps every function slug to its own `LEASH_CATEGORIES` array; `getLeashGuide('<slug>')` returns the plain-English guide the CEO's Guide tab renders. An empty array (Marco today) yields `defined:true, autonomous:[]` + only the generic CEO escalation rails — no dead "leash not yet defined" empty state.
- **M3 dispatch** — `scripts/builder-worker.ts` `runDirectorCoachJob` · one dispatch table gate per function; in-leash cards run the executor, out-of-leash cards fan out to `escalateApprovalRequestToCeo` with the director's slug/label.
- **Audit trail** — every card that lands writes one [[../tables/director_activity]] row with `director_function = <slug>`; every rail hit lands one [[../tables/approval_decisions]] row with `decided_by='ceo'` naming the leash category the rail crossed. `scripts/_confirm-director-chat-audit-trail.ts` sweeps both surfaces for every live director in one script (marco-logistics-director-seat Phase 4).
- **Coach backend** — [[../specs/generalize-director-coach-backend]] · the shared framing + coach-output selector routed at `coachOutputFor(directorFunction)` so a new persona plugs in with one import + one map entry.
- **In-leash execution** — [[../specs/director-chat-in-leash-execution]] · the M3 dispatch → executor → `director_activity` write-back Marco piggybacks on (his row never fires because his in-leash Set is empty).

## Invariants

- **A director grades only workers in its own charge.** Same north-star principle enforced at [[../libraries/agent-grader]] `gradeableKindsForFunction` — a supervisor owns the layer below, not adjacent departments. See [[../operational-rules]] § North star.
- **No leash bypass.** A card outside the director's `LEASH_CATEGORIES` never touches an executor; it can only escalate via `escalateApprovalRequestToCeo`. The M3 dispatch treats an empty `LEASH_CATEGORIES` naturally: every card misses the in-leash check → falls into the escalation branch.
- **One row per action.** The audit contract every cockpit obeys: an in-leash approve lands one `director_activity` row; a rail-hit lands one `approval_decisions` row and no `director_activity` write from the director-side.
- **Persona identity is registry-owned.** Every persona lives in `src/lib/agents/personas.ts` (see [[../libraries/agent-personas]]); adding a director = one PERSONAS entry + one `DIRECTOR_LEASH` map entry + one `coachOutputFor` branch + one M3 dispatch Set. The four cockpits + Eve are the current cast.

## Status / open work

**Shipped:** the four cockpits above wired to the shared coach backend, with the leash + M3 dispatch + audit trail contract enforced end-to-end. Marco is the fourth seat; Eve's god-mode cockpit is orthogonal (personal-EA surface) but shares the persona registry + Message Center rendering.

**Open work:** Marco's executor slice — [[../specs/marco-logistics-executor-surface]] — planned; opens the two crisis-cohort levers to autonomous action once the founder-driven inventory build model matures.

## Related

[[../libraries/director-leash-guide]] · [[../libraries/director-coach-threads]] · [[../libraries/agent-personas]] · [[../tables/director_activity]] · [[../tables/approval_decisions]] · [[../tables/function_autonomy]] · [[ada-slack-chat]] · [[ada-slack-routed-approvals]] · [[god-mode]] · [[../functions/platform]] · [[../functions/growth]] · [[../functions/cs]] · [[../functions/logistics]] · [[../operational-rules]]
