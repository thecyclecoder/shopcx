# inngest/unanswered-inbound-backstop-cron

Cron safety net for a **lost `ticket/inbound-message` event**. A customer reply is ingested into `ticket_messages`, then a `ticket/inbound-message` event fires so [[unified-ticket-handler]] handles it. If that `inngest.send` is silently dropped (a widget/webhook blip, a cold start, an Inngest delivery hiccup) there is **no retry and no trace** — the customer sits unanswered on an open ticket forever. This cron finds those stranded tickets every 5 min and **re-fires the same event** the original ingest should have.

Root cause it exists for: ticket `c4889020` — a chat follow-up whose inbound event never processed (zero handler notes; every handler bail writes a note). Re-firing the exact production event handled it flawlessly, proving the handler was fine and the event was simply lost.

**Two reconciliation paths:** Phase 3 ([[../specs/durable-inbound-dispatch-no-silently-lost-ticket-event]]) added an **intent-based** reconciler that runs in parallel with the legacy **message-age** path. Every 5 min both sweep candidates; the intent path is precise and fast, the message-age path is a floor for pre-Phase-2 rows.

**File:** `src/lib/inngest/unanswered-inbound-backstop-cron.ts`

## Functions

### `unanswered-inbound-backstop-cron`
- **Trigger:** cron `*/5 * * * *`
- **Concurrency:** `concurrency: [{ limit: 1 }]`

Two sweeps run in parallel every 5 minutes:

## Intent-based reconciler (Phase 3 — precise)

Since Phase 2, every ingest chokepoint stamps `dispatch_pending_at` on the just-inserted `ticket_messages` row **before** firing the event, and [[unified-ticket-handler]] `clearDispatchIntent`s the stamp on claim. An **UN-cleared stamp older than `INTENT_SETTLE_MS` is therefore an unambiguous LOST send** — not "handler declined the turn".

**Sweep:** Scan `ticket_messages` rows with `dispatch_pending_at IS NOT NULL AND dispatch_pending_at <= (now - INTENT_SETTLE_MS)` within this workspace, avoiding rows already backstopped (idempotency marker check). For each:

1. **Re-fire.** Sends `ticket/inbound-message` with `{ workspace_id, ticket_id, message_body: <inbound body>, channel, is_new_ticket: false }`.
2. **Clear the intent.** Set `dispatch_pending_at = null` on the message row.
3. **Increment lost-send counter.** Emits an observability counter so the true lost-send rate surfaces on the dashboard instead of being invisible until a customer complains.
4. **Insert idempotency marker** (shared with message-age path): `[System] {BACKSTOP_MARKER}` note.

**Windows / constants:**
- `INTENT_SETTLE_MS = 3 min` — comfortably covers Inngest's delivery + retry backoff on a healthy hop while still catching a genuine drop long before the 12-min message-age floor.
- `BATCH = 25` (per path)
- `LOST_SEND_ALARM_THRESHOLD = 3` — a single sweep reconciling this many intent-based lost sends signals a real hiccup (base rate is ~zero), so we surface a Control Tower dashboard alarm (per-workspace).

**Pure predicate:** `shouldIntentReconcile(input: IntentReconcileInput): boolean` returns true iff a row is an unambiguous lost send — stamp set + aged past settle + not already backstopped. Unit-pinned in the cron's test.

## Message-age reconciler (Phase 1 legacy floor)

Kept for **PRE-Phase-2 message rows** (backfilled `NULL` stamps) and any post-Phase-2 message that somehow ended up without an intent stamp — a longer 12-min age floor catches those with the older, coarser heuristic.

**Candidate pre-screen (`find-candidates` step).** Open, un-merged, `do_not_reply=false`, `ai_disabled=false`, `analyzer_locked=false`, `escalated_at` null, `assigned_to` null, with `last_customer_reply_at` inside the window `[now − BACKSTOP_MAX_AGE_MS, now − BACKSTOP_SETTLE_MS]`, oldest-first, `limit 25`. This is only an efficiency filter — the handler re-applies every gate on re-fire, so the states excluded here are exactly the ones where a re-fire would only bail with a note.

**Per-candidate decision (`shouldBackstopRedispatch`, pure + unit-pinned).** Re-dispatch ONLY when: AI is enabled for the channel; the newest customer-facing message is an **unanswered** inbound customer message (no `ai`/`agent`/system-external response at or after it); no uncancelled pending send is queued; not already backstopped; and its age ∈ `[BACKSTOP_SETTLE_MS, BACKSTOP_MAX_AGE_MS]`. Messages come from [[../libraries/tickets-read]] `getTicketMessages`; AI-on is a cached per-`(workspace, channel)` `ai_channel_config.enabled` lookup.

**Idempotency.** Before firing, it inserts an internal `[System] {BACKSTOP_MARKER}` note (marker `"Unanswered-inbound backstop"`) that sits **after** the customer's last message. The next sweep sees that marker and skips the ticket, so a slow (or lost-twice) handler is never spammed with duplicate dispatches. The note is internal, so it never counts as a customer-facing "response". **Both reconciliation paths share the same marker**, so intent-reconciled + message-age-reconciled rows both skip together.

**Re-fire.** Sends `ticket/inbound-message` with `{ workspace_id, ticket_id, message_body: <customer's last body>, channel, is_new_ticket: false }` — the identical event the ingest should have.

**Windows / constants:**
- `BACKSTOP_SETTLE_MS = 12 min` (clears the 5-min pending-send delay + buffer so a handler that IS about to reply is never raced)
- `BACKSTOP_MAX_AGE_MS = 24 h` (older = stale, not a live wait)
- `BATCH = 25`

## Observability

**Control Tower heartbeat fires on every tick, including idle ones** — `{ ok: true, detail: "idle" }` on the no-candidate early-return, `{ ok: true, detail: "redispatched N/M" }` otherwise — so an idle cron reads green instead of tripping monitor `never_fired`. Lost-send counter increments on intent-based reconciles so the true drop rate surfaces as a metric instead of being invisible until a customer complains.

## Downstream events sent

- `ticket/inbound-message` → [[unified-ticket-handler]] (the re-fire)

## Tables written

- [[../tables/ticket_messages]] — the internal idempotency-marker note

## Tables read (not written)

- [[../tables/tickets]]
- [[../tables/ticket_messages]]
- `ai_channel_config`

---

[[../README]] · [[../integrations/inngest]] · [[../operational-rules]] · [[../../CLAUDE]]
