# libraries/automated-sender

Deterministic pre-filter predicate that identifies automated / no-reply senders + automated-notification body markers so an inbound ticket from one of them can be closed WITHOUT paying for the Haiku classifier or any downstream AI. Phase 2 of [[../specs/outreach-tickets-deterministically-close-no-sol-dispatch-no-ai-cost]].

**File:** `src/lib/automated-sender.ts`

## Why this exists

The unified handler's classify-bucket Haiku step (see [[../inngest/unified-ticket-handler]] § 1b) costs a small but real fraction of a cent per new ticket. Most of that cost is legitimate — the classifier decides `account | general | outreach` and its output routes real customer messages. But an entire subclass of inbound is DETERMINISTICALLY recognizable without a model call: TestFlight builds, App Store receipts, mailer daemons, GitHub notifications, marketing "please do not reply" retailer blasts. These are outreach in the analytics sense and never customer-service, so paying for a Haiku classification is pure waste. Phase 2's mandate: this subclass costs ZERO AI dollars.

## Exports

- `isAutomatedSender(fromAddress: string | null | undefined): boolean` — matches known automated senders by (a) local-part regex `/(no[-_]?reply|donotreply|do[-_]not[-_]reply)/i` (substring — `testflight_no_reply` counts), (b) standalone-mailer exact-match `/^(mailer[-_]daemon|postmaster|bounces?)$/i`, OR (c) domain / subdomain in the narrow `AUTOMATED_DOMAINS` allowlist (`email.apple.com`, `bounces.google.com`, `noreply.github.com`, `notify.trustpilot.com`). Null / empty / malformed → false.
- `bodyHasAutomatedMarker(body: string | null | undefined): boolean` — four tight phrases only: "please do not reply to this email|message", "this mailbox|inbox|email address is not monitored", "this is an automated email|message|notification|response", "you are receiving this email|message because you (are|have) subscribed|subscribed|opted in". Conservative on purpose — a genuine customer would never write these.
- `isAutomatedInbound(fromAddress, body): boolean` — the OR of the two above. This is what the handler calls.

## Design invariants

- **False-positive-averse** (spec verification bullet 2). A genuine customer email from a normal address (`customer@gmail.com`, `first.last+ordertag@outlook.com`, `dylan@apptivi.com`) must NEVER trip the filter. Every widening of the local-part regex or the domain allowlist has to be checked against the test suite before it lands.
- **Domain allowlist is a hard commitment.** A domain here means EVERY inbound from it is closed without reply, forever, no matter what the body says. Add senders here only when you're certain they're 100% automated.
- **Look-alike domains DO NOT match.** `email.apple.com` matches `email.apple.com` and any subdomain (`push.email.apple.com`), but NOT `apple.com` or `notapple.com` — the check is `d === domain || domain.endsWith("." + d)`.

## Callers

- [[../inngest/unified-ticket-handler]] § 1a2 — the pre-classifier short-circuit calls `isAutomatedInbound` (via [[outreach-route]] `decideOutreachRoute`) before the classify-bucket Haiku step. A true return path costs zero AI dollars.

## Testing

`src/lib/automated-sender.test.ts` — 12 node:test cases. Run:

```
npx tsx --test src/lib/automated-sender.test.ts
```

Pins verification bullet 1 (`testflight_no_reply@email.apple.com` trips), bullet 2 (four normal customer addresses do NOT trip, including `+tag` addresses), bullet 3 (three brand-collab senders on human-looking domains fall through — Phase 1 catches them via the classifier), null/empty/malformed inputs, standalone-mailer exact-match rejects substrings (`postmaster.eu@x.com`, `bouncehouse@events.com`), and look-alike domain rejection (`tim@apple.com` does NOT trip when only `email.apple.com` is in the allowlist).

---

[[../README]] · [[../../CLAUDE]]
