# libraries/holding-message-defer

The deferred-holding wiring for the Sol frustration branch. Turns the "we're looking into that for you" stall into a scheduled pending row that the [[../inngest/deliver-pending-send]] cron only ships if no substantive reply lands first ([[../specs/the-holding-message-only-sends-if-the-real-reply-is-actually-slow]] Phase 1).

**File:** `src/lib/holding-message-defer.ts` · **Tests:** `src/lib/holding-message-defer.test.ts` (`npm run test:holding-defer`)

## Why this exists

Before this module, [[./inflection-detector]]'s Phase-2 gate dispatched "We're looking into that for you." synchronously the moment a frustration verdict came back. Sol's re-session typically produced the real answer within 0–3 minutes on the same channel — so an already-frustrated customer received a stall followed almost immediately by the substantive reply. Two messages where one would have been better, and the first read as a brush-off. June flagged the pattern twice as `sol_messy_turns` on the 2026-08-25 wrong-merchant thread ("took two redundant looking-into-it turns before the substantive investigation"), where it happened three separate times across eight days.

The fix is a WHEN change, not a WHETHER change. The holding message is still valuable — it buys patience during a genuinely slow investigation. It stops spending goodwill only in the fast-reply case.

## Exports

```ts
const HOLDING_MESSAGE_BODY = "We're looking into that for you.";
const HOLDING_DEFER_MS = 90_000;

function shouldCancelPendingHolding(input: {
  pendingSendAt: Date | string | null;
  sentAt: Date | string | null;
  now: Date | number;
}): boolean;

async function enqueuePendingHolding(
  admin: SupabaseClient,
  ticketId: string,
  sandbox: boolean,
): Promise<void>;

async function cancelPendingHoldingMessagesForTicket(
  admin: SupabaseClient,
  ticketId: string,
): Promise<void>;
```

- `shouldCancelPendingHolding` — pure predicate on the pending row's `{pendingSendAt, sentAt, now}` tuple. Isolated in its own module (with no inflection-detector import) so tests can exercise the decision without booting the Haiku transport / direction loader / agent-jobs SDK the detector pulls in.
- `enqueuePendingHolding` — writes the holding row. Live mode: `visibility='external'`, `pending_send_at = now + HOLDING_DEFER_MS`. Sandbox mode: `visibility='internal'`, `body='[AI Draft] …'`, no `pending_send_at` (mirrors `send()`'s sandbox branch in unified-ticket-handler.ts).
- `cancelPendingHoldingMessagesForTicket` — CAS on `ticket_id=? AND body=HOLDING_MESSAGE_BODY AND sent_at IS NULL AND send_cancelled=false AND pending_send_at IS NOT NULL`. A holding row the cron already dispatched (has `sent_at` stamped) is never retroactively marked cancelled — the ledger must not lie about what the customer received.

## Wiring

1. **Enqueue** (frustration verdict): `unified-ticket-handler.ts` §2084 `sendHoldingMessage` callback → `enqueuePendingHolding(admin, tid, cfg.sandbox)`. Replaces the old synchronous `sendWithDelay(...)` call.
2. **Cancel** (substantive reply): `unified-ticket-handler.ts` §290 `send()` calls `cancelPendingHoldingMessagesForTicket(admin, tid)` before every outbound insert, skipping only when the message being sent IS the holding text itself. Placed at the SINGLE send chokepoint every reply path traverses (Sonnet, playbook, canned responses, first-touch ack, action-executor macros), so no path can silently ship the stall behind the real answer.

## Rules the predicate encodes

| `sentAt` | `pendingSendAt` vs `now` | Verdict |
|---|---|---|
| set | any | **NO cancel** — already delivered; marking cancelled rewrites history |
| null | in the past | **NO cancel** — deadline passed, cron may have dispatched or is about to; late holding is better than silent drop |
| null | in the future | **YES cancel** — this is the fast-reply case the spec is designed around |
| null | null (row is not pending) | **NO cancel** — the row isn't a pending send at all |

The DB write layers `.is("sent_at", null)` + `.eq("send_cancelled", false)` on top of this predicate as a belt-and-suspenders race guard against the cron picking the row up between the predicate call and the update.

## `HOLDING_DEFER_MS` — 90 seconds

Chosen from the 2026-08-25 thread's real timings (substantive replies followed the holding by 0–3 minutes). 90s sits at the low end of the spec-pinned 60–120s range — long enough to suppress the fast case (which accounts for the "sent seconds before the real answer" complaint), short enough that a genuinely-slow investigation still gets the buy-patience message before the customer gives up. The [[../inngest/deliver-pending-send]] cron runs every 5 minutes (CEO 2026-07-11 monitoring-cost guardrail), so the effective dispatch window after enqueue is `[90s, 90s + cron-tick-lag]` — in practice any reply that completes within ~5 minutes races the cron pick-up and wins.

## Verification pins

`npm run test:holding-defer` covers:

- **fast reply BEFORE deadline** → holding cancelled, `sent_at` stays null.
- **slow reply AFTER cron dispatched** → cancel is a no-op, `send_cancelled` stays false, `sent_at` preserved.
- **no reply at all** → row remains pending and eligible for cron delivery.
- **feature flag OFF** → `enqueuePendingHolding` is never called (flag gate lives in [[./inflection-detector]] `applyInflectionGate`), so no row is written.
- **mixed pending rows on the same ticket** — a scheduled review-request draft or canary hold is untouched by the body-scoped cancel filter.

## Related

- [[./inflection-detector]] — `applyInflectionGate` calls the injected `sendHoldingMessage` callback whose production impl now routes to `enqueuePendingHolding`.
- [[../inngest/deliver-pending-send]] — the 5-minute cron that dispatches pending outbound rows whose `pending_send_at` has passed and skips `send_cancelled` ones.
- [[../tables/ticket_messages]] — the row schema (`pending_send_at`, `sent_at`, `send_cancelled`).
- [[../specs/the-holding-message-only-sends-if-the-real-reply-is-actually-slow]] — Phase 1 spec this module implements.
