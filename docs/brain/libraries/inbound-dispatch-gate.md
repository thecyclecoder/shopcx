# inbound-dispatch-gate

**Phase 1 of [[../specs/durable-inbound-dispatch-no-silently-lost-ticket-event]].** Pure predicate that decides whether a fresh customer inbound message should fire a `ticket/inbound-message` event to [[../inngest/unified-ticket-handler]].

**File:** `src/lib/inbound-dispatch-gate.ts`

## Problem it solves

Before this module, every ingest chokepoint (widget messages, email/sms/meta webhooks, portal support, journeys, csat, apply-playbook, help) branched its dispatch decision on the **legacy `ai_handled` boolean** — a stored flag distinct from the universal handling-anchor `ai_handled_at` timestamp stamped by [[ticket-delivery]] `deliverTicketMessage`. Ticket `c4889020` (a chat follow-up) sat unanswered forever because its row carried `ai_handled_at != null` (AI had answered the prior turn) yet the legacy boolean was still `false` — the divergence case slipped past every ingest gate and no dispatch fired.

The predicate here decides off the **reliable dispatch-state fields** — `ai_handled_at` (universal "AI has handled this ticket" anchor), `assigned_to` (human ownership), `ai_disabled` (hard-stop AI directive), `do_not_reply` (silence marker) — and never reads the stale `ai_handled` boolean. See [[../tables/tickets]] for the field distinctions.

## Exports

### `shouldDispatchInboundMessage(t: InboundDispatchState): boolean`

The Phase-1 dispatch predicate. Returns true iff a fresh customer inbound message on this ticket should fire a `ticket/inbound-message` event.

**Semantics (in order):**
1. `ai_disabled` or `do_not_reply` set → **NEVER dispatch** (hard human/system directives).
2. `ai_handled_at` set → **ALWAYS dispatch** (the divergence case). AI has been handling this conversation; a fresh customer reply is the next turn regardless of `assigned_to` (which may be a soft/pooled assignment).
3. Otherwise, dispatch iff `assigned_to` is null (no human owns it → AI takes the turn).

**Semantics as code:**
```ts
export function shouldDispatchInboundMessage(t: InboundDispatchState): boolean {
  if (t.ai_disabled) return false;
  if (t.do_not_reply) return false;
  if (t.ai_handled_at) return true;
  if (!t.assigned_to) return true;
  return false;
}
```

### `interface InboundDispatchState`

The reliable dispatch-state fields on a `public.tickets` row. Callers pass this shape (never the legacy `ai_handled` boolean) so a future refactor cannot re-introduce the divergence bug at the call sites.

| Field | Type | Notes |
|---|---|---|
| `ai_handled_at` | `string \| null` | Universal "AI has responded to this ticket" anchor — stamped by `deliverTicketMessage` on every real customer-facing AI/system-external send. Never read the legacy `ai_handled` boolean here. |
| `assigned_to` | `uuid \| null` | UUID of the workspace member who owns the ticket. Non-null = a human took it. |
| `ai_disabled` | `boolean \| null` | Hard human directive: "AI is off on this ticket." Overrides everything, including `ai_handled_at`. |
| `do_not_reply` | `boolean \| null` | Deliberate silence marker (mailer-daemon inbound, etc.). Never dispatch. |

## Callers

Every ingest chokepoint routes through [[dispatch-inbound-message]] `dispatchInboundMessage`, which applies this gate **before** firing the event. Also called by [[../inngest/unified-ticket-handler]] at the receiving end (after loading the ticket, before re-dispatching) so source-side + handler-side gates are aligned.

## Verification

Unit tests in `src/lib/inbound-dispatch-gate.test.ts` pin the divergence case — a ticket with `ai_handled_at` set but `ai_handled=false` and no human `assigned_to` still dispatches a `ticket/inbound-message` event on a new customer reply. Assertions on every other condition (ai_disabled, do_not_reply, human-assigned cases).

## Gotchas

- Pure over its input — no DB, no clock, no side-effects. The predicate is a thin wrapper over a comparison; all branching is deterministic.
- The legacy `ai_handled` boolean is NEVER read here — the predicate lives in the namespace of reliable fields only.
- Callers MUST pass the typed `InboundDispatchState` shape, not ad-hoc field references. Passing `{ ai_handled: ... }` instead of `{ ai_handled_at: ... }` is a compile error by design.

---

[[../README]] · [[dispatch-inbound-message]] · [[../inngest/unified-ticket-handler]] · [[../inngest/unanswered-inbound-backstop-cron]] · [[../tables/tickets]]
