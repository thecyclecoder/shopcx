# inngest/ticket-response-sla-watchdog

The **30-minute response SLA guarantee** ([[../specs/every-inbound-handled-within-30-min]] Phase 1). Every failure mode on 2026-10-07 (tickets 09f7257a / 2acc8634 / 668bc5c8 / Sanja's edf7331f) ended the same way: a Sol or Sonnet turn failed or produced no reply, and **nothing owned the ticket after that**. The [[unanswered-inbound-backstop-cron]] handles the LOST-INGEST class (a `ticket/inbound-message` event that was dropped), but it does NOT fire when a dispatch landed, the handler claimed, and the turn FAILED — the stamp is cleared, no customer-facing reply was sent, and the ticket just sits open until a human notices.

This watchdog is the catch-net for THAT class. Every 5 minutes it finds open tickets whose newest inbound customer message has sat past the response SLA with no outbound external reply, no reply queued, and no live claim on it (no active playbook turn, not already escalated, no inflight `cs-director-call`), and **enqueues ONE `cs-director-call` agent_jobs row for June**. June rules before the founder is paged — the spec forbids escalating directly to the founder from this surface.

**File:** `src/lib/inngest/ticket-response-sla-watchdog.ts`

## Function

### `ticket-response-sla-watchdog`

- **Trigger:** cron `*/5 * * * *`
- **Concurrency:** `concurrency: [{ limit: 1 }]`
- **Owner:** `cs` (June)
- **Registered:** [[../libraries/control-tower]] `MONITORED_LOOPS` · `livenessWindowMs = 20 min`

### Flow

1. **Find candidates.** `tickets` where `status = 'open'`, `merged_into IS NULL`, `escalated_at IS NULL`, `assigned_to IS NULL`, `active_playbook_id IS NULL`, and `last_customer_reply_at` is inside `[now - SLA_MAX_AGE_MS, now - TICKET_RESPONSE_SLA_MS]`. Ordered oldest-first, capped at `BATCH = 25`.
2. **Inflight guard.** Skip any ticket already carrying a queued / claimed / building / needs_input `cs-director-call` job (`spec_slug = ticket id`). Mirrors the sibling guards in [[../libraries/needs-attention-route-cs-owner]] and [[triage-escalations-cron]].
3. **Per-ticket compare-and-set.** Re-read the ticket at write time and re-check the full predicate (`shouldRouteToJune`) against actual message history so another sweep / a human reply / a human takeover between the batch read and the enqueue never produces a stale route.
4. **Idempotency marker.** Insert ONE internal `ticket_messages` note (direction `outbound`, visibility `internal`, author_type `system`, body `[System] 30-min response SLA breached — routed to June`). The next sweep sees this note after the customer message and skips (`alreadyMarked`).
5. **Enqueue `cs-director-call`.** Same shape as [[triage-escalations-cron]] and [[../libraries/needs-attention-route-cs-owner]]: `spec_slug = ticket id`, `instructions = { ticket_id, sla_breach: { last_customer_at, last_response_at, waited_ms, sla_ms, source: 'ticket-response-sla-watchdog' } }`. **Never sets `escalated_to` to the founder** (or anyone — this surface leaves ticket escalation fields alone; June's runner owns any status transition).
6. **Heartbeat.** `emitCronHeartbeat('ticket-response-sla-watchdog', { ok, produced, detail })` at the end of every run.

## Constants

- `TICKET_RESPONSE_SLA_MS = 30 min` — the breach threshold. Pinned in the unit test.
- `SLA_MAX_AGE_MS = 24 h` — don't resurrect an ancient open ticket; shares a ceiling with [[unanswered-inbound-backstop-cron]] `BACKSTOP_MAX_AGE_MS`.
- `SLA_BREACH_MARKER = "30-min response SLA breached — routed to June"` — the exact `[System]` note body the spec mandates. Both the write and the next-sweep skip read it, so changing the string breaks idempotency.
- `BATCH = 25` — per-tick candidate cap.

## Pure predicate

`shouldRouteToJune(i: SlaBreachInput): boolean` — unit-pinned in `ticket-response-sla-watchdog.test.ts`. Returns true iff:

- a customer inbound external message exists and is aged into `[slaMs, maxAgeMs]`,
- no outbound customer-facing response sits at or after that message,
- no outbound send is queued (`pending_send_at && !sent_at && !send_cancelled`),
- no prior `SLA_BREACH_MARKER` note sits after the customer message.

The predicate is the SAME shape as [[unanswered-inbound-backstop-cron]] `shouldBackstopRedispatch` — this cron catches the FAILED-TURN class while that cron catches the LOST-INGEST class; together they close the "nothing owns this ticket" gap for the full 30-min SLA.

## North-star contract

- **Never pages the founder from this surface.** The spec is explicit: breaches route to **June (`cs-director-call`)**, not the CEO. The founder owns objectives; June (the CS Director) owns tickets. See [[../operational-rules]] § North star.
- **Compare-and-set on every route.** The read-batch + per-ticket re-read + per-message idempotency marker together make a double-route impossible under racing sweeps or an async human reply.
- **Node-completeness trio** (CLAUDE.md hard rule): registered in `MONITORED_LOOPS` (owner `cs`, cadence 5 min, livenessWindowMs 20 min, satisfying `assertRegistryInvariants`'s 1.2× jitter grace); the `cs` department kill switch cascades down via the canonical registry so no separate `kill_switches` row is needed (fail-open invariant: MISSING ROW ⇒ ON); heartbeat emitted at the end of every run.

## Related

[[../specs/every-inbound-handled-within-30-min]] · [[unanswered-inbound-backstop-cron]] (sibling catch-net for the lost-ingest class) · [[triage-escalations-cron]] (hourly June-review enqueue — same `cs-director-call` shape) · [[../libraries/needs-attention-route-cs-owner]] (same enqueue + inflight-dedupe pattern) · [[../libraries/cs-director]] · [[../tables/agent_jobs]] · [[../tables/ticket_messages]] · [[../libraries/control-tower]]
