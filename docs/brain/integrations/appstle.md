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
| `/subscription-contracts/{id}?cancellationFeedback={reason}&cancellationNote={note}` | DELETE | Cancel a sub. Reasons: `fraud`, `chargeback`, `customer_request`, etc. **Not a hard delete** — reversible via the update-status PUT below. |
| `/subscription-contracts-update-status?contractId={id}&status=PAUSED\|ACTIVE` | PUT | Pause (`PAUSED`) / resume + **reactivate** (`ACTIVE`). `status=ACTIVE` un-cancels a cancelled contract, not just an unpause. |
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
| `/subscription-contract-details/replace-variants-v3` | POST | **Batch line-item mutation** — add / remove / swap multiple variants in one call. See below. |
| `/subscription-contracts-update-shipping-address?contractId={id}` | PUT (JSON body) | Update shipping address (countryCode/provinceCode required) |
| `/subscription-contracts-update-line-item-pricing-policy?contractId&lineId&basePrice` | PUT | **Heal** a `pricingPolicy: null` line — set `basePrice` + a cycle-discount array (max 2) so the line regains structured S&S pricing without changing the charge. Per-line (`lineId` required). See [[../libraries/appstle-pricing]]. |

### `replace-variants-v3` body

```json
{
  "shop": "store.myshopify.com",
  "contractId": 123456,
  "eventSource": "CUSTOMER_PORTAL",
  "oldVariants": [123, 456],            // variant IDs to remove
  "oldLineId": "gid://...",             // OR single line ID (mutually exclusive with oldVariants)
  "oldOneTimeVariants": [789],
  "newVariants": { "123": 2 },          // variant ID → quantity to add
  "newOneTimeVariants": { "456": 1 },
  "stopSwapEmails": false,
  "carryForwardDiscount": "COUPON_CODE"
}
```

Returns `200` with updated contract JSON. `lines` may be absent if processed async — re-fetch via `contract-raw-response` if you need to confirm.

Internal-subscription guard: `isInternalSubscription()` short-circuits these calls and updates Postgres directly. See `src/lib/internal-subscription.ts`.

**Heal-on-touch gateway:** every Appstle **mutation** routes through `healOnTouch`/`appstleMutate` ([[../libraries/appstle-pricing]]) first, which heals any `pricingPolicy: null` line (via the pricing-policy endpoint above) before the mutation lands. No new code may call `subscription-admin.appstle.com` to mutate a contract without that guard. Cancel + migration skip the heal (the sub is being killed / re-homed).

## Response shape conventions

- Most endpoints return `204 No Content` on success. Our wrapper code checks `!res.ok && res.status !== 204`.
- `replace-variants-v3` returns `200` with body.
- `contract-raw-response` (GET) returns the full Shopify subscription contract including discount nodes.
- Coupon endpoints use specific status codes for errors: `409` (conflict — already applied), `404`, `422`, `400`.
- Webhook signature verification uses Svix with `webhook-*` header prefix.

## Rate limits + retry

- No published rate limit. Empirically forgiving; we don't backoff aggressively.
- `loggedAppstleFetch()` in `src/lib/appstle-call-log.ts` records every call into [[../tables/appstle_api_calls]] — endpoint, status, response, latency. Use it to debug intermittent failures.
- Errors surface as `{ success: false, error: "..." }` from action helpers — callers decide whether to escalate or retry.

## Webhooks

Drives [[../tables/billing_forecast_events]] (sub created, cancelled, paused, frequency changed) and dunning entry via `dunning/payment-failed` event. Payloads: contract create / update / cancel / pause / resume; billing-attempt failure + success; line-item swap. Svix-signed via `webhook-id`, `webhook-timestamp`, `webhook-signature` headers, verified against `workspaces.appstle_webhook_secret_encrypted`.

### Handler ack semantics (`/api/webhooks/appstle/[workspaceId]`)

- **Pre-handler rejections return non-2xx** and are the *only* non-2xx responses: `400` (missing webhook headers), `401` (invalid signature), `404` (workspace has no `appstle_webhook_secret_encrypted`). Appstle should retry these.
- **Once the signature verifies, the handler always acks 2xx** — even if processing throws. A 500 here makes Appstle retry the *same* payload, which throws again and re-runs partial side-effects; a retry can't fix a handler/data bug. The top-level `catch` logs richly (event type + contract/customer ref) and returns `{ ok: false, acked: true }`. Missed state self-heals via the periodic subscription sync + reconcile. (Before this, unguarded throws on `subscription.billing-*` events recurred ×11 in the Control Tower error feed.)
- **`billingAttemptResponseMessage` is parsed via `parseBillingError()`** — a guarded helper. Appstle sends it as a JSON *string* on failures but it can arrive null/empty/already-parsed; a bare `JSON.parse` throws and was a 500 source. All three parse sites in the route use the helper.

## Gotchas

- **`DELETE` for cancel is required.** PUT to PAUSED ≠ cancel; PUT to CANCELLED won't carry the `cancellationFeedback` that Appstle expects.
- **Cancel is reversible — it is NOT a hard delete.** A cancelled contract is reactivated by the update-status PUT with `status=ACTIVE` — the same call as resume-from-paused. In code this is `appstleSubscriptionAction(ws, contractId, "resume")`, which sets the contract back to `ACTIVE` and the local row to `active`. Used to undo erroneous fraud cancellations and for win-back restarts (see `scripts/restart-brad-coffee-sub-d31f8183.ts`, step 1). After reactivating, re-check the next billing date — a reactivated contract may carry a stale/past `nextBillingDate` and bill immediately; reschedule via `update-billing-date` if needed. Full how-to: [[../lifecycles/subscription-billing]] § Reactivating a cancelled subscription.
- **Internal subscriptions bypass Appstle entirely.** Helpers check `is_internal` first; new code must too — `appstleSubscriptionAction()` shows the pattern.
- **One-time gift on an Appstle sub = `newOneTimeVariants` + zero-or-rollback.** `replace-variants-v3` `newOneTimeVariants: {variantId: qty}` adds a one-time (next-order-only) item natively, but the map carries no price — a **free** gift needs its line's base price zeroed via `update-line-item-price` (`basePrice=0.00`) after the add. [[../libraries/subscription-items]] `subAddOneTimeGift` does add → resolve the one-time line GID → zero → **roll back the add (`oldOneTimeVariants`) if $0 can't be confirmed**, so a "gift" never silently bills. The one-time-line GID shape on a live Appstle contract isn't yet confirmed; the rollback makes an unconfirmed attempt safe (fail-closed), and a guaranteed-free delivery falls back to a standalone $0 gift order.
- **Post-migration cancel webhook must match the OLD id.** The migration ([[../libraries/migrate-to-internal]]) cancels the Appstle contract then RENAMES the row's `shopify_contract_id` to `internal-…`. The `subscription.cancelled` webhook that cancel fires arrives (async) with the **old numeric id**. The webhook's migrated-internal guard (`handleSubscriptionEvent`) therefore matches on `shopify_contract_id OR migrated_from_contract_id` — matching only `shopify_contract_id` missed the renamed row and INSERTED a dead `is_internal=false` cancelled shell (portal false-OOS; see [[../tables/subscriptions]] `migrated_from_contract_id` + [[../libraries/portal__order-now-guard]]).
- **Built-in retries + skip-after-X-failures must be DISABLED** in Appstle settings — our dunning engine owns that logic. See Phase 5 in CLAUDE.md.
- **Cancellation note carries who+why:** include the operator's display_name (`"Cancelled by Dylan on ShopCX.ai — fraud"`) so it shows up in Appstle's UI for any human review.
- **discountId for remove** is Appstle's internal id, not the Shopify code. Get it from `appstleGetSubscriptionContract()`.
- **Two payment helper endpoints** exist for "switch card" — `update-existing-payment-method` (what we use) vs Appstle's UI flow. Don't mix them.
- **Audit log fills fast.** [[../tables/appstle_api_calls]] gets a row per call; expect to query it via index on `(workspace_id, created_at)`.

## Files

- `src/lib/appstle.ts` — All endpoint helpers
- `src/lib/appstle-discount.ts` — `applyDiscountWithReplace()` (remove old → apply new in one atomic flow)
- `src/lib/appstle-call-log.ts` — `loggedAppstleFetch()` wrapper
- `src/lib/appstle-pricing.ts` — pricing heal + the `appstleMutate` mutation gateway

## Related

[[../tables/subscriptions]] · [[../tables/appstle_api_calls]] · [[../tables/billing_forecast_events]] · [[../tables/dunning_cycles]] · [[../tables/payment_failures]] · [[../tables/coupon_mappings]] · [[../tables/remedies]] · [[../libraries/appstle-pricing]] · [[../inngest/dunning]] · [[../inngest/import-subscriptions]] · [[../inngest/internal-subscription-renewals]]
