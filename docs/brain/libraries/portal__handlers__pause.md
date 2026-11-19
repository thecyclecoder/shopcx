# libraries/portal/handlers/pause

Portal pause sub.

**File:** `src/lib/portal/handlers/pause.ts`

## Exports

### `pause` — const

```ts
const pause: RouteHandler
```

Pausing for N days (30/60) sets the next renewal to **the old `next_billing_date` + N days**, not today + N days. The new renewal is computed by the pure helper [[portal__pause-renewal-date]] `computePausedRenewalDate(nextBillingDate, pauseDays, now)` — `base = max(nextBillingDate, now)`, then `base + pauseDays`. The handler writes that date to BOTH `pause_resume_at` and `next_billing_date` on the row, and the confirmation reads "your next order is now &lt;date&gt;".

## Gotchas

- **Pause counts from the next renewal, not from today.** It used to anchor the resume to `today + pauseDays` ("Resume date is X days from TODAY"), so a customer whose renewal was weeks out saw a pause that barely moved their charge, while [[../inngest/portal-auto-resume]] `retimeAfterResume` then re-derived the date off the cycle grid — so the shown pause length never matched reality (Laura Light, ticket b74b5a1c: Jan 12 renewal, "Pause 60 days" showed Jan 17). Now the future `next_billing_date` the pause writes is honored verbatim on resume.
- The portal UI (`shopify-extension/portal-src/js/screens/SubscriptionDetail.jsx` `PauseCard`) reads the resume date from the server response (`resumeAt`), not a local `today + days` guess — rebuild portals after editing portal-src (CLAUDE.md).

## Callers

_No internal callers found via static scan._

---

[[../README]] · [[../../CLAUDE]]
