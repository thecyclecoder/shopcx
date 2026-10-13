# libraries/date-change-ask

Pure detector for the "customer wants to MOVE / PUSH / SKIP / DELAY / PAUSE their next order" ask. Phase 2 of [[../specs/inflection-resession-must-act-on-newest-ask]].

**File:** `src/lib/date-change-ask.ts` · **Tests:** `src/lib/date-change-ask.test.ts` · **Registered:** `test:date-change-ask`

## Why it exists

Ground truth: ticket dc31bf31 (Aug 2026). At 2026-08-05 14:14 the customer wrote _"Can we move order to Oct 30th as I ordered enough Aug n Sept???????"_. The [[./inflection-detector]] classified it `kind='frustration'` (`cues=['repeated_punct']`), Sol re-answered the Sep 2 ship-date question and never moved the date — the customer was billed four weeks early, costing a $237.16 refund + a cancelled subscriber (SHOPCX481).

Phase 1 of the spec surfaced the triggering message to Sol via [[./inflection-detector]] `trigger_message`. Phase 2 closes the loop with a pure, synchronous detector the send path consults — a draft that would ship a status-only reply over an unaddressed date-change ask is HELD and the session is re-sessioned.

## Contract

```ts
export interface DateChangeAsk {
  isAsk: boolean;
  requestedDate: string | null; // "YYYY-MM-DD" or "0000-MM-DD" (needs year) or null (ambiguous)
}

export function detectDateChangeAsk(text: string): DateChangeAsk;

export function decisionAddressesDateChange(decision: {
  actions?: Array<{ type?: string }> | null;
  needs_clarification?: boolean;
  clarification_question?: string | null;
}): boolean;
```

### `detectDateChangeAsk` fires on

1. A **change-verb** (`push · move · shift · delay · postpone · skip · pause · hold off · reschedule · change`, lightly stemmed) **AND** either (a) a date token (ISO / US-slash / month-name / ambiguous "next month"), or (b) an order-subject anchor (`order · shipment · delivery · renewal · refill · box · package · charge · billing · subscription · cycle · next one`).
2. A **concrete calendar date** co-occurring with an **order-subject anchor** — "my next shipment Oct 30" fires even without a verb like "move".

### `requestedDate` resolution

- ISO literal `YYYY-MM-DD` → passes through verbatim.
- US-slash `M/D[/YY]` → `YYYY-MM-DD` (year falls to sentinel `0000` when the message omits it).
- Month-name `Oct 30`, `October 30th, 2026` → `YYYY-MM-DD` (year falls to sentinel `0000` when the message omits it).
- Ambiguous (`next month`, `soon`, `later this week`, `end of the month`) → `null`. The gate's downstream job is to drive a clarifying-question Direction, not to guess the day.
- No concrete date hits + the ask still fires on verb + subject anchor → `null`.

The sentinel `0000` year is the detector's "needs year" signal — the gate's send-path consumer picks up the real year from the ticket's active subscription (which the pure detector does not read) when posting its internal note.

### `decisionAddressesDateChange` passes when

- `actions` contains **at least one** of `change_next_date` / `skip_next_order` / `pause`, OR
- `needs_clarification === true`, OR
- `clarification_question` is a non-empty string.

A clarifying question is a valid "address" — deferring to the customer rather than silently restating an older answer is the dc31bf31 fix.

## Wire-in — the unified-ticket-handler send-path gate

[[../inngest/unified-ticket-handler]] calls both helpers in the `date-change-ask-gate` step, between `sonnet-orchestrate` and `sonnet-execute`:

```ts
const ask = detectDateChangeAsk(msg);
if (ask.isAsk && !decisionAddressesDateChange(sonnetDecision)) {
  // Draft is held — post an internal note naming the requested date (or "ambiguous — needs
  // clarify") and re-session Sol with reason='unaddressed_date_ask' via `reSessionSol`.
  //                                                                        ↑
  // Phase 1 of this spec threads the newest ticket_messages row onto the new session's
  // instructions, so the bounced Sol prompt now carries BOTH the triggering message AND
  // the explicit "address THIS message" framing.
  return { status: "date_change_ask_held" };
}
```

Guards:

- The gate is wrapped in a `step.run()` so Inngest's at-least-once retries don't double-fire the `reSessionSol`; `reSessionSol`'s own compare-and-set (superseded_at IS NULL) is the second belt.
- `reSessionSol` is called with `kind: 'drift'` + `evidence.reason='unaddressed_date_ask'` so the [[../tables/ticket_resolution_events]] stamp distinguishes this gate from the Phase-2 inflection-gate bounces (`sol:inflection-{drift|frustration}`).
- A `reSessionSol` throw does NOT ship the reply — the draft stays held, a diagnostic note lands, and the next inbound turn re-enters the gate (fail-safe: same posture as the inflection gate's ledger insert).

## Testing

```bash
npm run test:date-change-ask
```

Fixtures taken directly from the dc31bf31 transcript:

- 14:14 _"Can we move order to Oct 30th as I ordered enough Aug n Sept???????"_ → MUST fire (`isAsk=true`, `requestedDate='0000-10-30'`).
- 14:06 _"Thank you So much!!!!!"_ → MUST stay silent (`isAsk=false`).

Plus the negative anchors ("move my address", "pause my music") and `decisionAddressesDateChange` coverage.

## Related

- [[../specs/inflection-resession-must-act-on-newest-ask]] — the parent spec. Phase 1 wires the triggering message onto the re-session instructions; this file is Phase 2.
- [[../specs/every-inbound-handled-within-30-min]] — Phase 4 (the date-change gate with `stripQuotedAndForwarded`). This module's quote/forward stripper closes the ground-truth incident ticket 09f7257a where a forwarded order-confirmation email's "Skip · Pause" buttons false-positived on `detectDateChangeAsk`.
- [[./inflection-detector]] — the per-turn inflection gate the detector pairs with; its Phase-2 ledger prefix (`sol:inflection-*`) is distinct from this gate's `sol:unaddressed_date_ask`.
- [[./cs-director]] — Phase 3's `findUnsatisfiedCustomerRequests` reuses `detectDateChangeAsk` on inbound messages newer than the last executed action, so June can't close-no-action over an unanswered date-change ask.
- [[../inngest/unified-ticket-handler]] — the send-path gate's call site, between `sonnet-orchestrate` and `sonnet-execute`.
