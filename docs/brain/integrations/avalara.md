# avalara

Avalara AvaTax — sales tax calculation + commit for the custom storefront + subscription billing. Replaces Shopify's built-in tax engine post-cutover.

## Auth

- **Encrypted on `workspaces`:** `avalara_license_key_encrypted`
- **Plain on `workspaces`:**
  - `avalara_account_id`
  - `avalara_company_code` — Avalara company identifier
  - `avalara_environment` — `production` or `sandbox`
  - `avalara_origin_address` (JSONB) — ship-from address
  - `avalara_default_tax_code` — fallback tax code when product is missing one
  - `avalara_enabled` (bool) — feature gate

Auth: HTTP basic `Authorization: Basic base64(account_id:license_key)`.

## Key endpoints we call

| Environment | Base |
|---|---|
| Production | `https://rest.avatax.com` |
| Sandbox | `https://sandbox-rest.avatax.com` |

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v2/transactions/create` | POST | Quote tax for a cart / sub (type=SalesOrder, no commit) |
| `/api/v2/transactions/createoradjust` | POST | Commit a transaction (type=SalesInvoice, with commit) |
| `/api/v2/transactions/{companyCode}/{transactionCode}/void` | POST | Void a committed transaction (refunds) |

## Quote vs commit

- **Cart-time quotes**: `SalesOrder` type, `commit: false`. Cached on [[../tables/cart_drafts]] / [[../tables/subscriptions]] with `avalara_quote_*` columns + `avalara_quote_at`. Re-validated at checkout.
- **At checkout / billing tick**: `SalesInvoice` with `commit: true` → records on Avalara's books for filing. Transaction code stored on [[../tables/orders]].`avalara_transaction_code` and `avalara_committed_at`.

## Rate limits + retry

- 100 req/sec per account.
- Stale quotes (`avalara_quote_at` > X hours old) → re-quote before checkout.
- Failures fall back to a flat tax estimate per state — better than blocking checkout. Logged for review.

## Gotchas

- **Tax codes per product variant**, not per product. Avalara expects `taxCode` on each line item — we fall back to `avalara_default_tax_code` when missing.
- **Origin address must be valid** — Avalara validates against USPS. A bad `avalara_origin_address` poisons every quote.
- **Quote ≠ commit.** Quotes don't appear on Avalara's filing reports. Tax filers care about committed transactions only. Don't accidentally commit a quote.
- **Void on refund.** Don't just refund money in Braintree without voiding the Avalara transaction — otherwise you over-remit tax. `voidReason` should be `DocVoided` for full refunds.
- **Date handling.** Avalara uses your account's filing timezone, not UTC. Transactions dated in the wrong tz can land in the wrong filing period.
- **Sandbox is API-compatible** but rates are fake. Test integration logic in sandbox, prove rates in a single production transaction before going live workspace-wide.

## Files

- `src/lib/avalara.ts` — Core client (HTTP + auth + transactions)
- `src/lib/avalara-cart.ts` — Quote for [[../tables/cart_drafts]]
- `src/lib/avalara-subscription.ts` — Quote for [[../tables/subscriptions]]
- `src/lib/avalara-tax-codes.ts` — Tax code lookup by variant

## Related

[[../tables/orders]] · [[../tables/cart_drafts]] · [[../tables/subscriptions]] · [[../tables/pricing_rules]] · [[../tables/product_variants]]
