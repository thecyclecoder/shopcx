# libraries/portal/escalate-sol-rail-hit

Escalate a ticket to June's triage-escalation lane when Sol hits her leash. Originally portal-only (Phase 3 of [[../specs/portal-errors-route-to-sol-first-escalate-to-june-on-rail]]); now the **general** path for EVERY Sol rail-hit via `escalateSolRailHit(admin, {workspace_id, ticket_id, sol_reason, rail})` (`rail`: `first_touch` | `inflection` | `portal` → selects the `escalation_reason` prefix `sol_rail_hit` / `sol_portal_rail_hit`). `escalateSolPortalRailHit` remains as a deprecated `rail:'portal'` alias. When Sol returns `{"status":"escalate_to_june","reason":"…"}` — OR a guard/honor block kills her reply, OR the policy gate wasn't run — she can't resolve within her leash, so the worker (deterministic Node — the only mutator) sets the ticket into the routine escalation lane [[../inngest/triage-escalations]] picks up on its next tick and enqueues a `cs-director-call` for June. That IS the escalation ladder (Sol → June → founder). **There is no "needs human" in CS** — no human does mutations; June is the CS final call and loops in the founder (via Eve's SMS) only when she needs to.

**File:** `src/lib/portal/escalate-sol-rail-hit.ts`

## What it does

`escalateSolPortalRailHit(admin, {workspace_id, ticket_id, sol_reason})` compare-and-sets the ticket:

| Column | Value |
|---|---|
| `escalated_at` | `now()` |
| `escalated_to` | `null` (the routine signal [[../inngest/triage-escalations]] filters on) |
| `escalation_reason` | `sol_portal_rail_hit: <Sol's reason>` (verbatim; blank → `(no reason given)`) |
| `updated_at` | `now()` |

Nothing is bundled on the escalate call itself. The June review reads:

- the durable **Direction** from `ticket_directions` (live row + any prior superseded rows Sol may have re-authored) — Sol's chosen_path + plan + guardrails,
- **Sol's attempts** from `ticket_resolution_events` (every turn Sol drove) + `ticket_messages` (every reply she shipped),
- the ticket itself + merged customer + subscription + order context.

The escalation carries only the REASON — that is enough to identify the rail Sol hit; the artifacts are already durable on the ticket.

## Design decisions

- **Compare-and-set on `.is('escalated_at', null)`.** Learning #2/#3 — refuse to overwrite an existing escalate at the mutating action point. A ticket that was already escalated by a prior `sol_resession_cap_hit` (from [[./inflection-detector]] `reSessionSol`) or an auto-heal `escalate()` (from [[./portal__remediation]]) keeps that reason. The FIRST escalate wins; a subsequent Sol rail-hit becomes a no-op with `reason: "already_escalated"` and the audit trail is preserved.
- **Workspace-scoped write.** `.eq('workspace_id', ws)` on both the mutating update AND the follow-up "was the row missing or already escalated?" probe — a cross-workspace ticket-id collision cannot cross the boundary.
- **`.select('id')` single-row assertion.** Zero rows transitioned → the helper distinguishes `not_found` (mis-enqueued / cross-workspace) from `already_escalated` (compare-and-set correctly refused) via a follow-up read, so the wire-in surfaces a specific audit line instead of swallowing the state.
- **Portal-only wire-in.** In `runTicketHandleJob` the escalate call is gated on `params.reason === "portal_error"`. A non-portal ticket-handle job (`first_touch` inbound message, `inflection` bounce) still marks itself `needs_attention`; the RAIL is portal-specific because that's the intake this spec changed. The other reasons already have their own rail mechanisms.
- **Escalate failure never wedges the job.** A failed update surfaces the error in the job's log_tail but the `needs_attention` status transition still lands — the CS Director sees the punt regardless. Same discipline the Phase-2 spec-author failure follows.
- **Stable prefix `sol_portal_rail_hit:`.** Grep-able against the DB and rendered verbatim on any human-facing view of the ticket. Exported as `SOL_PORTAL_RAIL_HIT_REASON_PREFIX` so downstream (June's review skill, analytics tiles) reads the same constant.

## Exports

- `escalateSolPortalRailHit(admin, {workspace_id, ticket_id, sol_reason})` → `{escalated, reason}`.
- `buildSolPortalRailHitReason(solReason)` → the exact `escalation_reason` string written to the row. Pure — tested independently.
- `SOL_PORTAL_RAIL_HIT_REASON_PREFIX` → `"sol_portal_rail_hit"` constant.

## Callers

- `scripts/builder-worker.ts` — `runTicketHandleJob`, the `escalate_to_june` branch AND the blocked-reply (guard/honor) branch, for EVERY rail (`rail: params.reason === "portal_error" ? "portal" : "first_touch"`). Called BEFORE the `agent_jobs` `needs_attention` status transition so a failed escalate cannot wedge the escalate.

## Related

- [[./portal__enqueue-sol-first-touch]] — Phase 1: the portal-intake enqueue with `reason: "portal_error"` that primes Sol as the first responder.
- [[./portal__sol-proposed-spec]] — Phase 2: Sol's dual output on the happy path (customer fix ALWAYS, code-fix spec on structural cause).
- [[../inngest/triage-escalations]] — the hourly cron that enqueues `cs-director-call` for routine-owned escalated tickets. This is where Sol's rail-hit tickets land.
- [[./inflection-detector]] — the sibling escalate that fires on `sol_resession_cap_hit` (Sol's re-session cap). Same escalate shape (`escalated_to=null`, distinct reason string).
- [[./portal__remediation]] — the auto-heal / dismiss / escalate lane. Its own `escalate()` also lands in the same routine lane; Phase 3 does not touch it (Sol's rail-hit is the new entry, not a replacement).

---

[[../README]] · [[../../CLAUDE]] · [[../specs/portal-errors-route-to-sol-first-escalate-to-june-on-rail]]
