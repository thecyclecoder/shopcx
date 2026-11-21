# libraries/subscription-reactivate

Restart a cancelled or paused subscription. The ONE implementation for both surfaces that can
restart a subscription: the portal Reactivate button and the win-back journey's
"Yes, restart my subscription" step. (CEO rule 2026-11-16: portal and journey stay in sync.)

**File:** `src/lib/subscription-reactivate.ts`

## Exports

### `reactivateSubscription(workspaceId, contractId, { nextBillingDate? })` → `ReactivateResult`

```ts
type ReactivateResult =
  | { ok: true; contractId: string; nextBillingDate: string; revivedOnShopcx: boolean }
  | { ok: false; reason: "needs_payment_method" | "needs_address" | "appstle_not_configured" | "error"; message: string; details?: unknown };
```

1. Never-migrated Appstle sub (appstle_retired on) → [[commerce__shopcx-revive]] `ensureShopcxEngine(..., "resume")`
   rebuilds it on ShopCX from our mirror, ACTIVE on the chosen date, at the customer's own price.
   `contractId` in the result is the NEW ShopCX contract id.
2. ShopCX contract → `subscriptionUpdateNextBillingDate` through the commerce SDK.
3. Legacy Appstle (switch off only) → Appstle billing-date API.
4. Resume via `subscriptionAction(..., "resume")` (internal-aware), or `applySubscriptionStatusTruth`
   for a just-revived contract; then the local `subscriptions` row is stamped `active` +
   `next_billing_date`.

Never throws: typed refusals (`needs_payment_method`, `needs_address`) and errors come back as
`ok: false` for the caller to surface honestly.

### `defaultReactivationDate()` → ISO string, tomorrow + 15 min.

## Callers

- [[portal__handlers__reactivate]] — maps `needs_*` to 409, other failures to `handleAppstleError`.
- [[winback-reactivate-choice]] `handleReactivateChoice` — the win-back journey's click
  ([[reactivate-journey-builder]] / journey `reactivate-subscription`), called from BOTH
  `/api/journey/[token]/complete` (the page posts there whenever the journey has a `steps` array,
  which the win-back does) and `/step`. Runs synchronously on the click, marks the session `completed` with outcome `reactivated` / `declined` /
  `reactivate_needs_payment_method` / `reactivate_needs_address` / `reactivate_failed`,
  sets `outcome_action_taken: true` (so [[../inngest/journey-outcomes]] does not run it twice),
  writes `journey_sessions.subscription_id`, a ticket note, a `winback.reactivated` /
  `winback.reactivate_failed` customer event (countable conversions + visible failures), and returns the real result message the page shows.
- [[../inngest/journey-outcomes]] `outcome === "reactivated"` branch (kept for any multi-step
  caller that emits that outcome).

## Gotchas

- **2026-11-21 bug this fixed:** the page posted `/complete` with outcome `completed`, but the
  outcome handler only restarted on outcome `reactivated`, and keyed on `session.subscription_id`,
  which `scripts/winback-mixed-berry.ts` never set. The page then said "All done! We've updated
  your account."
  Clicks on "Yes, restart" restarted nothing while the page said "we'll email you".
- A card or address problem is NOT auto-resolved here: the customer is told plainly, and an
  internal ticket note flags it for follow-up (only when the session has a `ticket_id`).
