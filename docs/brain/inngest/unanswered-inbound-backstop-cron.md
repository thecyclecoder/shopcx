# inngest/unanswered-inbound-backstop-cron

Cron safety net for a **lost `ticket/inbound-message` event**. A customer reply is ingested into `ticket_messages`, then a `ticket/inbound-message` event fires so [[unified-ticket-handler]] handles it. If that `inngest.send` is silently dropped (a widget/webhook blip, a cold start, an Inngest delivery hiccup) there is **no retry and no trace** — the customer sits unanswered on an open ticket forever. This cron finds those stranded tickets every 5 min and **re-fires the same event** the original ingest should have.

Root cause it exists for: ticket `c4889020` — a chat follow-up whose inbound event never processed (zero handler notes; every handler bail writes a note). Re-firing the exact production event handled it flawlessly, proving the handler was fine and the event was simply lost.

**File:** `src/lib/inngest/unanswered-inbound-backstop-cron.ts`

## Functions

### `unanswered-inbound-backstop-cron`
- **Trigger:** cron `*/5 * * * *`
- **Concurrency:** `concurrency: [{ limit: 1 }]`

**Candidate pre-screen (`find-candidates` step).** Open, un-merged, `do_not_reply=false`, `ai_disabled=false`, `analyzer_locked=false`, `escalated_at` null, `assigned_to` null, with `last_customer_reply_at` inside the window `[now − BACKSTOP_MAX_AGE_MS, now − BACKSTOP_SETTLE_MS]`, oldest-first, `limit 25`. This is only an efficiency filter — the handler re-applies every gate on re-fire, so the states excluded here (merged / do_not_reply / ai_disabled / analyzer_locked / escalated / human-assigned) are exactly the ones where a re-fire would only bail with a note.

**Per-candidate decision (`shouldBackstopRedispatch`, pure + unit-pinned).** Re-dispatch ONLY when: AI is enabled for the channel; the newest customer-facing message is an **unanswered** inbound customer message (no `ai`/`agent`/system-external response at or after it); no uncancelled pending send is queued; not already backstopped; and its age ∈ `[settleMs, maxAgeMs]`. Messages come from [[../libraries/tickets-read]] `getTicketMessages`; AI-on is a cached per-`(workspace, channel)` `ai_channel_config.enabled` lookup.

**Idempotency.** Before firing, it inserts an internal `[System] {BACKSTOP_MARKER}` note (marker `"Unanswered-inbound backstop"`) that sits **after** the customer's last message. The next sweep sees that marker and skips the ticket, so a slow (or lost-twice) handler is never spammed with duplicate dispatches. The note is internal, so it never counts as a customer-facing "response".

**Re-fire.** Sends `ticket/inbound-message` with `{ workspace_id, ticket_id, message_body: <customer's last body>, channel, is_new_ticket: false }` — the identical event the ingest should have.

**Windows / constants.** `BACKSTOP_SETTLE_MS = 12 min` (clears the 5-min pending-send delay + buffer so a handler that IS about to reply is never raced); `BACKSTOP_MAX_AGE_MS = 24 h` (older = stale, not a live wait); `BATCH = 25`.

**Control Tower heartbeat fires on every tick, including idle ones** — `{ ok: true, detail: "idle" }` on the no-candidate early-return, `{ ok: true, detail: "redispatched N/M" }` otherwise — so an idle cron reads green instead of tripping monitor `never_fired`.

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
