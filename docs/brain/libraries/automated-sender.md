# libraries/automated-sender

Deterministic pre-filter predicate that identifies automated / no-reply senders + automated-notification body markers so an inbound ticket from one of them can be closed WITHOUT paying for the Haiku classifier or any downstream AI. Phase 2 of [[../specs/outreach-tickets-deterministically-close-no-sol-dispatch-no-ai-cost]].

**File:** `src/lib/automated-sender.ts`

## Why this exists

The unified handler's classify-bucket Haiku step (see [[../inngest/unified-ticket-handler]] § 1b) costs a small but real fraction of a cent per new ticket. Most of that cost is legitimate — the classifier decides `account | general | outreach` and its output routes real customer messages. But an entire subclass of inbound is DETERMINISTICALLY recognizable without a model call: TestFlight builds, App Store receipts, mailer daemons, GitHub notifications, marketing "please do not reply" retailer blasts. These are outreach in the analytics sense and never customer-service, so paying for a Haiku classification is pure waste. Phase 2's mandate: this subclass costs ZERO AI dollars.

## Exports

- `isAutomatedSender(fromAddress: string | null | undefined): boolean` — matches known automated senders by (a) local-part regex `/(no[-_]?reply|donotreply|do[-_]not[-_]reply)/i` (substring — `testflight_no_reply` counts), (b) standalone-mailer exact-match `/^(mailer[-_]daemon|postmaster|bounces?)$/i`, OR (c) domain / subdomain in the narrow `AUTOMATED_DOMAINS` allowlist (`email.apple.com`, `bounces.google.com`, `noreply.github.com`, `notify.trustpilot.com`). Null / empty / malformed → false.
- `bodyHasAutomatedMarker(body: string | null | undefined): boolean` — four tight phrases only: "please do not reply to this email|message", "this mailbox|inbox|email address is not monitored", "this is an automated email|message|notification|response", "you are receiving this email|message because you (are|have) subscribed|subscribed|opted in". Conservative on purpose — a genuine customer would never write these.
- `isAutomatedInbound(fromAddress, body): boolean` — the OR of the two above. This is what the handler calls.
- `bodyHasAutoReplyOrNotificationMarker(body: string | null | undefined): boolean` — a BROADER body classifier for the out-of-office / auto-reply class (`out of office`, `automatic reply`, `auto-reply`, `on vacation|holiday|leave`, `I am currently out|away|unavailable`), the vendor-notification / legal-policy blast class (vendor-voiced "we've updated our … terms|privacy|policy|cookie", "changes/updates to our terms of service|privacy policy", etc.), AND the chargeback-mitigation / dispute-vendor blast class (ticket `5dcb1240`: `FPRONE`/`FPR-ONE`, `ChargebackGurus`, an `Alert ID` paired within 80 chars with a `refund|chargeback|dispute|gateway|descriptor` cue, or vendor-voiced "attempt (a) refund … in the Gateway / for the Alert / to avoid a chargeback"). Vendor-voiced + dispute/policy-scoped so a real customer asking us to "update my address / change my delivery date" or "I want a refund / please refund me" never trips.
- `isAutoReplyOrNotificationInbound(fromAddress, body): boolean` — `isAutomatedInbound(...) || isChargebackVendorSender(fromAddress) || bodyHasAutoReplyOrNotificationMarker(body)`. A SUPERSET of `isAutomatedInbound`, used ONLY by the CS Director `close_no_action` guard exclusion (see Callers) — NOT by the zero-cost outreach auto-close, which keeps the narrow `bodyHasAutomatedMarker` so a false-positive can't close a real customer without reply. `isChargebackVendorSender` is a private helper matching the narrow `CHARGEBACK_VENDOR_DOMAINS` allowlist (`chargebackgurus.com` + subdomains) — the dispute-vendor From-address signal from ticket `5dcb1240`.

## Design invariants

- **False-positive-averse** (spec verification bullet 2). A genuine customer email from a normal address (`customer@gmail.com`, `first.last+ordertag@outlook.com`, `dylan@apptivi.com`) must NEVER trip the filter. Every widening of the local-part regex or the domain allowlist has to be checked against the test suite before it lands.
- **Domain allowlist is a hard commitment.** A domain here means EVERY inbound from it is closed without reply, forever, no matter what the body says. Add senders here only when you're certain they're 100% automated.
- **Look-alike domains DO NOT match.** `email.apple.com` matches `email.apple.com` and any subdomain (`push.email.apple.com`), but NOT `apple.com` or `notapple.com` — the check is `d === domain || domain.endsWith("." + d)`.

## Callers

- [[../inngest/unified-ticket-handler]] § 1a2 — the pre-classifier short-circuit calls `isAutomatedInbound` (via [[outreach-route]] `decideOutreachRoute`) before the classify-bucket Haiku step. A true return path costs zero AI dollars.
- [[cs-director]] `findUnsatisfiedCustomerRequests` — the `close_no_action` guard exclusion calls `isAutoReplyOrNotificationInbound` per inbound message, so a cue word (`change|update|refund|…`) inside an auto-reply / OOO / vendor-notification / dispute-vendor blast does NOT count as an unsatisfied customer request. Ticket `f3977ec6` (a GemX Terms/Privacy-update blast) matched the `change` cue on "updated" and looped forever between June's close and Sol's re-session until this exclusion gave the notification class a real silent-close terminal. Ticket `5dcb1240` is the same loop class: a chargebackgurus.com / FPRONE dispute-alert bot resent "please attempt a refund for Alert ID …" (no order, amount, card, or matching charge) and the `refund` cue downgraded a correct `close_no_action` to `needs_sol_resession_unsatisfied_ask` forever — the chargeback-vendor markers + domain signal give it the silent-close terminal too. See [[../specs/close-no-action-guard-must-exempt-notification-and-auto-reply-emails]].

## Downstream progress accounting

The handler's sysNote on a pre-filter close (`[System] Automated-sender pre-filter tripped (sender=…) — deterministically closed, no AI response, classify-bucket skipped (zero AI cost).`) counts as a **streak-resetting handled turn** in [[no-progress-guard]] — the substring `Automated-sender pre-filter tripped` is on the `ACTION_MARKERS` list. Deterministic handling IS progress: a run of pre-filter-closed inbounds (e.g. 13 auto-merged TestFlight spam invites from `testflight_no_reply@email.apple.com` on ticket `91579acf-67ef-4cb3-be89-0c9da7dac7af`) must not silently accumulate into `no_progress_context_cap` and escalate deterministic spam to the CS Director with no remedy.

## Testing

`src/lib/automated-sender.test.ts` — 19 node:test cases (the auto-reply / OOO / vendor-notification exemption cases pin the GemX Terms/Privacy blast + OOO/vacation replies tripping `bodyHasAutoReplyOrNotificationMarker`, `isAutoReplyOrNotificationInbound` being a strict superset of `isAutomatedInbound`, and a real "update my address" / "change my delivery date" customer ask NOT tripping; the last 3 pin ticket `5dcb1240`'s chargeback-vendor exemption: an `FPRONE` "attempt refund for Alert ID … in your Gateway" blast body trips `bodyHasAutoReplyOrNotificationMarker`, a `chargebackgurus.com` From-address trips `isAutoReplyOrNotificationInbound`, and a real customer "I want a refund / please refund me" does NOT trip). Run:

```
npx tsx --test src/lib/automated-sender.test.ts
```

Pins verification bullet 1 (`testflight_no_reply@email.apple.com` trips), bullet 2 (four normal customer addresses do NOT trip, including `+tag` addresses), bullet 3 (three brand-collab senders on human-looking domains fall through — Phase 1 catches them via the classifier), null/empty/malformed inputs, standalone-mailer exact-match rejects substrings (`postmaster.eu@x.com`, `bouncehouse@events.com`), and look-alike domain rejection (`tim@apple.com` does NOT trip when only `email.apple.com` is in the allowlist).

---

[[../README]] · [[../../CLAUDE]]
