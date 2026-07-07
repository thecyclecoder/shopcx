# CEO / Founder (function)

The permanent seat at the **top of the org chart** — the human founder (Dylan). Every autonomous tool answers to a role agent; every role agent answers to the CEO (CEO → role agent → tool, the [[../operational-rules]] § North star). This is the function that owns **company objectives**, the **final approval authority** (the fail-safe every out-of-leash escalation routes to — `CEO` in [[../libraries/approval-inbox|approval-inbox]] / `approval-router.ts`), and the **founder-level executive tooling** that has no departmental home because it IS the founder's own cockpit.

Distinguished from the departmental functions (Growth/CMO/Retention/CS/Platform) by *altitude*, not kind of work: the directors run their departments and author specs for the tools they need; the CEO sets the objectives those departments serve, breaks ties the leashes can't, and — until the autonomous executive layer exists — is the human-in-the-loop that remediates incidents and approves the irreversible.

> **Sunset trajectory.** The [[../goals/ceo-mode|CEO-mode]] goal is the program that stands an autonomous executive layer (CEO synthesizer + director agents) up underneath this seat. As those land, founder-level *manual* tooling owned here (e.g. God Mode) is explicitly retired — this function shrinks toward pure objective-setting + the irreversible-approval circuit-breaker. It is a permanent OWNER, but its manually-operated surface is deliberately temporary.

## Scope + owned metrics

- **Owns:** company objectives + the [[../goals|goals/BHAGs]] that decompose them; the final approval gate (irreversible / new-goal / non-binary decisions route here as the fail-safe); founder-level executive tooling with no departmental home (the God Mode incident cockpit).
- **North-star metrics:** the company-level goals themselves (revenue, retention, the active BHAGs) — the directors' KPIs roll up to these.

## Mandates (perpetual)

### CEO's executive-assistant agent
🌙 **Eve** — the founder's autonomous agent under the CEO seat (rendered in the Agents hub alongside company goals). She does anything the founder asks within the existing PIN + risk-tier approval gates ([[../lifecycles/god-mode#autonomous-executive-assistant--god-mode-becomes-ceos-agent-phase-8]] Phase 1 / Phase 2), surfacing her reasoning inline. Powered by the god-mode cockpit's live-gated approval model; the cockpit itself (an arm/disarm + SMS'd approval surface) remains a manual founder-only interface. Her liveness is derived from cockpit activity + loop heartbeats — a dormant armed session is healthy.
- **Metric:** autonomous remediation speed (incidents resolved without waking a director's intervention flow); zero silent mutations (all risky actions surface reasoning + ask).
- **Related:** [[../libraries/god-mode]] (session SDK) · [[../libraries/agent-personas]] (persona + org-chart reader) · [[../lifecycles/god-mode]] (full-power box lane + approval model).

### Founder incident cockpit
A manual, full-power bridge from the founder's phone to the build box, so a production incident can be remediated from anywhere while the autonomous executive layer doesn't yet exist. Reads/diagnostics fly; every risky write gates on a one-tap live approval (destructive actions additionally require a PIN). Deliberately thin and disposable — a stopgap, not a permanent surface.
- **Metric:** time-to-remediate an incident when the founder is away from the desk; God-Mode session safety (zero un-gated destructive writes).
- **Sunset:** retired when the CEO/director agents can self-remediate ([[../goals/ceo-mode]]).
- **Specs:** [[../specs/god-mode]] ✅ (shipped — phases 1–7 + Phase 8 Phase 1/2/Fix1 for Eve executive-assistant).

### Company objectives & the approval circuit-breaker
Own the company's goals and be the final, human approval authority for anything a director's leash can't autonomously clear — the irreversible, the brand-new goal, the non-binary judgment call. Every out-of-leash escalation fails safe to this seat.
- **Metric:** approval-queue latency (a blocked build shouldn't wait on the founder longer than it must); zero autonomous execution of an irreversible action without this gate.
- **Mechanics:** [[../libraries/approval-inbox]] `ownerFunctionForKind` (unmapped kind ⇒ CEO fail-safe) + `approval-router.ts` `CEO`; goal ownership in [[../project-management]].

## Owned / contributed goals

- [[../goals/ceo-mode]] — the program to build the autonomous executive layer beneath this seat (the CEO synthesizer + director agents). As it ships, the *manual* surface owned here retires.

## Status

Charter doc. The human-founder seat at the top of the CEO → role-agent → tool hierarchy: owns company objectives, the irreversible-approval circuit-breaker, and the (temporary) God Mode incident cockpit.

---

[[../README]] · [[platform]] · [[growth]] · [[cmo]] · [[retention]] · [[cs]] · [[../goals/ceo-mode]] · [[../operational-rules]] · [[../project-management]]
