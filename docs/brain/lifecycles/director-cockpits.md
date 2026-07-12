# Lifecycle: Director cockpits in the Message Center

The **four director cockpits + Eve** — the founder's supervision surface for every director-agent seat in the org chart, unified in one Message Center. Each director gets a first-person coach thread; the leash + M3 dispatch enforce **supervisable autonomy** ([[../operational-rules]] § North star): every in-leash executor auto-runs, every rail hit escalates via `escalateApprovalRequestToCeo`, and every action lands one `director_activity` row named by `director_function`.

Delivered by the **director-chats-in-message-center** goal (M1 generalize the coach backend off platform → M2 Message-Center launcher tabs → M3 in-leash execution → M4 per-director SMS cockpit → M5 Marco's seat), folded 2026-07-12 → [[../archive]]. Marco's read-only Logistics seat was the fourth cockpit and closed the goal.

## The directory

| Persona | Function | Where |
|---|---|---|
| **Ada** — Platform / DevOps Director | [[../functions/platform]] | [[../lifecycles/ada-slack-chat]] (Slack + web) · leash: `PLATFORM_LEASH` in [[../libraries/director-leash-guide]] |
| **Max** — Growth Director | [[../functions/growth]] | leash: `GROWTH_LEASH` in [[../libraries/director-leash-guide]] · reallocate / promote / hold cards |
| **June** — CS Director | [[../functions/cs]] | leash: `CS_LEASH` (`approve_remedy` / `author_derived_from_ticket_spec` / `amend_low_blast_sonnet_prompt`) per [[../specs/cs-director-leash-categories]] |
| **Marco** — Logistics Director *(LIVE leash-bound)* | [[../functions/logistics]] | leash: `LOGISTICS_LEASH` (`availability_toggle_within_crisis_lever` / `auto_readd_swapped_subscribers_within_crisis_cohort`) per [[../specs/marco-logistics-executor-surface]] Phase 2 — crisis-cohort scoped, M3 dispatch gates both on `requireCrisis()` guard |
| **Eve** — Executive Assistant *(god-mode cockpit)* | Cross-function EA | [[../lifecycles/god-mode]] — texts with the CEO from the cockpit, gates every risky write on PIN + risk-tier |

## Shared machinery (why the seats plug in without touching each other)

- **Coach threads** — [[../libraries/director-coach-threads]] + [[../tables/director_coach_threads]] · the same table row + turn body every seat uses; `director_function` disambiguates the persona.
- **Leash + guide** — [[../libraries/director-leash-guide]] · `DIRECTOR_LEASH` maps every function slug to its own `LEASH_CATEGORIES` array; `getLeashGuide('<slug>')` returns the plain-English guide the CEO's Guide tab renders. An empty array (Marco before [[../specs/marco-logistics-executor-surface]]) yielded `defined:true, autonomous:[]` + only the generic CEO escalation rails — no dead "leash not yet defined" empty state. Marco now carries two crisis-cohort categories post-Phase 2.
- **M3 dispatch** — `scripts/builder-worker.ts` `runDirectorCoachJob` · one dispatch table gate per function; in-leash cards run the executor, out-of-leash cards fan out to `escalateApprovalRequestToCeo` with the director's slug/label.
- **Audit trail** — every card that lands writes one [[../tables/director_activity]] row with `director_function = <slug>`; every rail hit lands one [[../tables/approval_decisions]] row with `decided_by='ceo'` naming the leash category the rail crossed. `scripts/_confirm-director-chat-audit-trail.ts` sweeps both surfaces for every live director in one script (marco-logistics-director-seat Phase 4).
- **Coach backend** — [[../specs/generalize-director-coach-backend]] · the shared framing + coach-output selector routed at `coachOutputFor(directorFunction)` so a new persona plugs in with one import + one map entry.
- **In-leash execution** — [[../specs/director-chat-in-leash-execution]] · the M3 dispatch → executor → `director_activity` write-back Marco piggybacks on (his row never fires because his in-leash Set is empty).

## SMS cockpit — text any director from your phone (M4)

Each director thread can be **armed for the phone** without forking a second SMS stack — it reuses Eve's `/god/[token]` cockpit surface end-to-end:

- **One URL surface, two disjoint token spaces.** `armDirectorCockpit` ([[../libraries/director-coach-threads]]) mints a 48-hex `cockpit_token` onto the [[../tables/director_coach_threads]] row with the SAME sliding + absolute TTLs as `god_mode_sessions`. A unique-per-token index on each table keeps the spaces disjoint, and **[[../libraries/cockpit-resolver]]** (`resolveCockpitTokenAny`) is the single chokepoint the `/god/[token]` routes call to decide `{kind:'god'|'director'}` — god_mode_sessions is checked first so Eve's path stays byte-for-byte unchanged; the director branch is purely additive.
- **`max` sandbox, never `godmode`.** A director cockpit token grants ONLY that director's leash — it PIN-gates exactly the same rails the in-app chat does and runs the read-only `max` sandbox, never Eve's prod-write `godmode`. A director cockpit can never reach a god-mode power.
- **Persona-named SMS, not Eve's voice.** `sendGodModeSMS` ([[../libraries/god-mode]]) grew director-scoped kinds — `director-arm` / `director-approval` / `director-done` — that interpolate the persona's plain name (`resolveDirectorPersonaName`) so a lock-screen text reads "You armed a chat with Max — cockpit: …", never Eve's flirt. Bodies stay deliberately clean (no emoji, no flirt); the full personality lives inside the app only.
- **Approval nudge parity.** `nudgeStaleDirectorApprovals` mirrors Eve's `nudgeStalePendingApprovals` on the box's 60s god-mode beat — a card sitting unanswered ≥ 5 min texts ONE reminder and stamps `sms_notified_at` so it never re-texts. Plain box replies push NO SMS (the Chat tab handles live watching); only the arm, the 5-min approval reminder, and session-done push.

## Invariants

- **A director grades only workers in its own charge.** Same north-star principle enforced at [[../libraries/agent-grader]] `gradeableKindsForFunction` — a supervisor owns the layer below, not adjacent departments. See [[../operational-rules]] § North star.
- **No leash bypass.** A card outside the director's `LEASH_CATEGORIES` never touches an executor; it can only escalate via `escalateApprovalRequestToCeo`. The M3 dispatch treats an empty `LEASH_CATEGORIES` naturally: every card misses the in-leash check → falls into the escalation branch.
- **One row per action.** The audit contract every cockpit obeys: an in-leash approve lands one `director_activity` row; a rail-hit lands one `approval_decisions` row and no `director_activity` write from the director-side.
- **Persona identity is registry-owned.** Every persona lives in `src/lib/agents/personas.ts` (see [[../libraries/agent-personas]]); adding a director = one PERSONAS entry + one `DIRECTOR_LEASH` map entry + one `coachOutputFor` branch + one M3 dispatch Set. The four cockpits + Eve are the current cast.

## Status / open work

**Shipped:** the four cockpits above wired to the shared coach backend, with the leash + M3 dispatch + audit trail contract enforced end-to-end. Marco is the fourth seat; Eve's god-mode cockpit is orthogonal (personal-EA surface) but shares the persona registry + Message Center rendering. Marco's executor slice — [[../specs/marco-logistics-executor-surface]] (2026-07-12) — wired the two crisis-cohort levers (`setStorefrontAvailability` + `auto_readd` bulk update) to operational autonomy.

## Related

[[../libraries/director-leash-guide]] · [[../libraries/director-coach-threads]] · [[../libraries/cockpit-resolver]] · [[../libraries/god-mode]] · [[../libraries/agent-personas]] · [[../tables/director_coach_threads]] · [[../tables/director_activity]] · [[../tables/approval_decisions]] · [[../tables/function_autonomy]] · [[ada-slack-chat]] · [[ada-slack-routed-approvals]] · [[god-mode]] · [[../functions/platform]] · [[../functions/growth]] · [[../functions/cs]] · [[../functions/logistics]] · [[../operational-rules]]
