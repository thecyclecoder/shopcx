# libraries/portal/pause-renewal-date

Pure helper for where a portal "pause N days" lands the next renewal.

**File:** `src/lib/portal/pause-renewal-date.ts`

## Exports

### `computePausedRenewalDate` — function

```ts
function computePausedRenewalDate(
  nextBillingDate: string | null,
  pauseDays: number,
  now: Date,
): string   // ISO string
```

`base = max(nextBillingDate, now)`, then `base + pauseDays` (added in UTC). A future renewal anchors
the pause; a past/missing `nextBillingDate` falls back to `now` so the pause is still the full length
the customer chose. Pure — no DB, no I/O — so it unit-tests cleanly.

## Callers

- [[portal__handlers__pause]] `pause` — stores the result in BOTH `pause_resume_at` and `next_billing_date`.

## Gotchas

- **Pause counts from the next renewal, not from today.** This replaced the old `today + pauseDays`
  anchor (Laura Light, ticket b74b5a1c: Jan 12 renewal + "Pause 60 days" → Mar 13, not Jan 17). The
  future date it produces is then honored verbatim by [[../inngest/portal-auto-resume]] `retimeAfterResume`.
- Tests: `src/lib/portal/pause-renewal-date.test.ts` (`npx tsx --test …`).

---

[[../README]] · [[../../CLAUDE]]
