# Internal-sub dunning + timeline ⏳

**Goal:** make failed-payment recovery (dunning) work for **internal** subs the way it works for Appstle subs — failures enter dunning, the customer gets a recovery email that routes to the new magic-link flow, the failure + recovery flow through `customer_events`/timeline, and the **AI ticket handler can reliably see and act on it**. The dunning system was built entirely around Appstle webhooks; internal subs (billed by Braintree) get none of those, so today they fall through every crack.

**Why now:** we're migrating subs to internal (heal + recovery flow shipped). Internal subs are now a growing share — and right now a failed internal renewal recovers *nothing*: no dunning cycle, no email, no timeline event, no AI visibility. That's lost "free" renewal revenue + blind support.

Audited 2026-06-09 (see findings below). Decisions still open.

## Audit findings — where Appstle ends and internal begins

| Aspect | Appstle subs | Internal subs |
|---|---|---|
| **Failure trigger** | Appstle `subscription.billing-failure` webhook → `webhooks/appstle/[ws]/route.ts:585` | Braintree decline in `internal-subscription-renewals.ts:283` |
| **Dunning cycle created?** | ✅ webhook creates it (rich: error_code, billing_attempt_id, cycle_id) | ❌ event fired at `:299` is **missing `shopify_contract_id`/`cycle_id`/`error_code`** → cycle creation fails |
| **`customer_events` logged?** | ✅ `subscription.billing-failure` / `-success` (appstle webhook `:558`) | ❌ no `logCustomerEvent` on decline |
| **`payment_failures` logged?** | ✅ | ❌ |
| **Recovery email sent?** | ✅ on cycle exhaustion (`sendDunningPaymentUpdateEmail`) | ❌ (no cycle) |
| **Card rotation / payday retries** | ✅ Appstle billing attempts | ❌ would need Braintree re-charge logic |
| **AI sees the failure?** | ✅ `get_dunning_status` reads `dunning_cycles`+`payment_failures` | ❌ "No dunning data" → agent blind |
| **Recovery email destination** | generic Shopify `/account` page | — (no email) |

**Five concrete gaps:**
1. Internal renewal fires an **incomplete** `dunning/payment-failed` (no `shopify_contract_id`/`cycle_id`/`error_code`) → no cycle.
2. Internal decline logs **no `customer_events`** → timeline blank for internal failures.
3. **Dunning writes ticket notes, not `customer_events`** — even for Appstle, dunning *activity* (rotations, payday retries, recovery) isn't on the timeline; it's only internal ticket notes. The AI reads `customer_events` + `get_dunning_status`.
4. Dunning's recovery email points at the generic Shopify `/account` page, **not** the new `generatePaymentRecoveryLink` flow ([[magic-link]]).
5. The whole Appstle dunning machinery (card rotation, payday Appstle billing attempts) **doesn't apply** to internal subs — they need a Braintree-native retry path.

## Proposed phases

### Phase 1 — Internal failures enter dunning ⏳
- `internal-subscription-renewals.ts`: on decline, **log `payment_failures` + a `customer_events` `subscription.payment_failed`** (so timeline + AI see it immediately, regardless of dunning), and fire a **complete** `dunning/payment-failed` (include `shopify_contract_id` (the `internal-*` id), a Braintree-derived `error_code`, `source`).
- `dunning.ts`: branch on `source === "internal_subscription_renewal"` (or `is_internal`): **skip Appstle card-rotation + Appstle payday billing-attempts**; create the cycle keyed on the internal sub; retries = re-fire the internal renewal (`internal-subscription/renewal-attempt`) on the payday schedule.

### Phase 2 — Recovery email → magic-link flow + ticket ⏳
- Dunning's payment-update email sends a **`generatePaymentRecoveryLink`** (7-day) instead of the Shopify `/account` URL — lands the customer on the card-add form that migrates + pins ([[customer-portal]] recovery).
- When that email goes out, **create/attach a ticket** so a reply is captured as a conversation (the customer often replies to "update your card" emails). Tag it `dunning:active`.

### Phase 3 — Timeline + AI visibility ⏳
- Dunning *activity* (cycle start, each retry, email sent, recovered/exhausted) writes `customer_events` (not just ticket notes), so the timeline tells the whole story.
- `get_dunning_status` already reads `dunning_cycles` + `payment_failures`; once Phase 1 populates those for internal subs, the AI sees internal failures too. Verify the tool surfaces `is_internal` + recovery-link status so the agent can say "I've sent you a link to update your card."

### Phase 4 — Internal billing-success closes the cycle ⏳
- Appstle closes a cycle on the `billing-success` webhook. Internal subs have no webhook — so a **successful internal renewal** (`internal-subscription-renewals.ts` success path) must fire `dunning/billing-success` (or directly mark the cycle `recovered`) + log `customer_events` `payment.recovered`. Without this, an internal cycle never closes.

## Open decisions

- **Internal retry cadence.** Reuse dunning's payday schedule (1st/15th/Fridays) re-firing the internal renewal? Or a simpler fixed backoff (e.g. day 1/3/5/7)? Appstle's card-rotation concept doesn't map (we have one default card).
- **When to email.** Appstle emails only after card rotations exhaust. Internal has no rotation — email on the **first** failure, or after N silent Braintree retries?
- **Ticket creation.** New ticket per dunning cycle, or attach to the most recent open ticket? Channel/persona for the recovery email?
- **Cancel/pause policy** on exhaustion for internal subs (Appstle cancels via API; internal just sets status).

## Related

[[../lifecycles/dunning]] · [[../inngest/internal-subscription-renewals]] · [[magic-link]] · [[../lifecycles/customer-portal]] · [[appstle-pricing-heal-and-migration-monitor]] · [[../tables/dunning_cycles]] · [[../tables/customer_events]]
