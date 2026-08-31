# closed-while-escalated-detector

`src/lib/closed-while-escalated-detector.ts` — READ-ONLY detector that surfaces tickets whose thread carries a founder/agent escalation note but whose row now sits `status='closed'` with the escalation columns cleared (`escalated_to IS NULL`). Phase 2 of [[../specs/closing-a-ticket-must-not-destroy-an-active-escalation]].

## Why

The 2026-08-28 investigation found this class by hand: 9 of 20 founder-escalated tickets in 21 days closed with the escalation gone; zero survived a close with it intact. Ticket 6b0cd91c (Denise Richling) had a confirmed system-side $102.33 duplicate charge unrefunded; her ticket auto-closed 4 h after the founder was asked to rule, and the only surviving trace was a CEO approval card. Phase 1 stopped the CLASS on new writes — this detector is the standing check that catches a regression if it re-emerges through a path Phase 1 doesn't cover (a raw update, a new code path, a data migration).

## Exports

| Symbol | Purpose |
|---|---|
| `ESCALATION_NOTE_MARKER` | The `[System] Escalating.` prefix written by [[../inngest/unified-ticket-handler]] `escalate` — the durable trace we search for. |
| `closedWhileEscalated(admin, { workspaceId, sinceIso?, sampleLimit? })` | Returns `{ count, sample }`. READ-ONLY — never writes, never reopens. `sampleLimit` capped at 50; `sinceIso` narrows to `closed_at >= …`. |

## Wiring

Registered as DB probe `tickets_closed_while_escalated_count` in [[spec-check-db-probes]] — the constrained allowlist a verification check / Control Tower tile is allowed to call (no free-form SQL). `requiresWorkspaceId: true` so a service-role admin client is tenant-bound. Evidence is the count + probe id only, never a row body.

## Post-Phase-1 signal shape

New closes preserve the escalation triple ([[tickets-mutate]] `closeTicket` + [[../inngest/unified-ticket-handler]] `setStatus`), so `closedWhileEscalated` should PLATEAU on legacy rows and NOT grow on new closes. A rising windowed count (`sinceIso` at or after Phase 1's ship date) is the regression signal.

Surface: count only, no auto-reopen — a settled ticket SHOULD be closed; the signal is for closes that happened while a decision was still outstanding. A human decides whether any row deserves reopening.

## Related

[[tickets-mutate]] · [[../inngest/unified-ticket-handler]] · [[spec-check-db-probes]] · [[../specs/closing-a-ticket-must-not-destroy-an-active-escalation]].
