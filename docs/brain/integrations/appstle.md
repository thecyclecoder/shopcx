# appstle

Appstle Subscriptions API. Per-workspace credentials. Subscription contracts live here today; we mirror in `subscriptions` and will become source of truth post-cutover.

## Auth

**API key + shop domain.** No OAuth.

- **Encrypted on `workspaces`:** `appstle_api_key_encrypted`
- **Plain:** `shopify_myshopify_domain` (the shop the API key is bound to)
- **Webhook secret:** `appstle_webhook_secret_encrypted`

Loaded via `getAppstleCredentials(workspaceId)` in `src/lib/appstle.ts`. Pass `api_key` and `shop` as query string params on every call.

## Key endpoints we call

Base: `https://subscription-admin.appstle.com/api/external/v2`

| Endpoint | Method | Purpose |
|---|---|---|
| `/subscription-contracts/{id}?cancellationFeedback={reason}&cancellationNote={note}` | DELETE | Cancel a sub. Reasons: `fraud`, `chargeback`, `customer_request`, etc. |
| `/subscription-contracts-update-status?contractId={id}&status=PAUSED\|ACTIVE` | PUT | Pause / resume |
| `/subscription-contracts-apply-discount?contractId={id}&discountCode={code}` | PUT | Apply a coupon |
| `/subscription-contracts-remove-discount?contractId={id}&discountId={id}` | PUT | Remove a coupon |
| `/subscription-contracts-skip?contractId={id}` | PUT | Skip next order |
| `/subscription-contracts-swap?contractId&oldVariantId&newVariantId` | PUT | Swap a variant |
| `/subscription-contracts-update-billing-interval?contractId&interval&intervalCount` | PUT | Change frequency |
| `/subscription-contracts-update-billing-date?contractId&nextBillingDate=...&rescheduleFutureOrder=true` | PUT | Change next billing date |
| `/subscription-contract-add-line-item?...` | POST | Add line item to a sub |
| `/subscription-billing-attempts/attempt-billing/{billingAttemptId}` | POST | Force a billing retry |
| `/subscription-billing-attempts/skip-upcoming-order?subscriptionContractId&shop` | POST | Skip the upcoming dunning order |
| `/subscription-billing-attempts/unskip-order/{billingAttemptId}` | POST | Undo a skip |
| `/subscription-billing-attempts/top-orders?contractId` | GET | Get upcoming order details |
| `/subscription-contracts-update-existing-payment-method?contractId&paymentMethodId` | PUT | Switch the vaulted card |
| `/subscription-contracts/{id}/send-payment-update-email` | POST | Trigger Appstle's payment-update email |

Internal-subscription guard: `isInternalSubscription()` short-circuits these calls and updates Postgres directly. See `src/lib/internal-subscription.ts`.

## Rate limits + retry

- No published rate limit. Empirically forgiving; we don't backoff aggressively.
- `loggedAppstleFetch()` in `src/lib/appstle-call-log.ts` records every call into [[../tables/appstle_api_calls]] — endpoint, status, response, latency. Use it to debug intermittent failures.
- Errors surface as `{ success: false, error: "..." }` from action helpers — callers decide whether to escalate or retry.

## Webhooks

Documented separately — see `APPSTLE-WEBHOOKS.md`. Drives [[../tables/billing_forecast_events]] (sub created, cancelled, paused, frequency changed) and dunning entry via `dunning/payment-failed` event.

## Gotchas

- **`DELETE` for cancel is required.** PUT to PAUSED ≠ cancel; PUT to CANCELLED won't carry the `cancellationFeedback` that Appstle expects.
- **Internal subscriptions bypass Appstle entirely.** Helpers check `is_internal` first; new code must too — `appstleSubscriptionAction()` shows the pattern.
- **Built-in retries + skip-after-X-failures must be DISABLED** in Appstle settings — our dunning engine owns that logic. See Phase 5 in CLAUDE.md.
- **Cancellation note carries who+why:** include the operator's display_name (`"Cancelled by Dylan on ShopCX.ai — fraud"`) so it shows up in Appstle's UI for any human review.
- **discountId for remove** is Appstle's internal id, not the Shopify code. Get it from `appstleGetSubscriptionContract()`.
- **Two payment helper endpoints** exist for "switch card" — `update-existing-payment-method` (what we use) vs Appstle's UI flow. Don't mix them.
- **Audit log fills fast.** [[../tables/appstle_api_calls]] gets a row per call; expect to query it via index on `(workspace_id, created_at)`.

## Files

- `src/lib/appstle.ts` — All endpoint helpers
- `src/lib/appstle-discount.ts` — `applyDiscountWithReplace()` (remove old → apply new in one atomic flow)
- `src/lib/appstle-call-log.ts` — `loggedAppstleFetch()` wrapper

## Related

[[../tables/subscriptions]] · [[../tables/appstle_api_calls]] · [[../tables/billing_forecast_events]] · [[../tables/dunning_cycles]] · [[../tables/payment_failures]] · [[../tables/coupon_mappings]] · [[../tables/remedies]] · [[../inngest/dunning]] · [[../inngest/import-subscriptions]] · [[../inngest/internal-subscription-renewals]]
