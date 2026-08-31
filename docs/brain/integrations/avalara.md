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

- **⚠️ An invalid tax code is NOT rejected — it is silently downgraded.** Send a `taxCode` Avalara
  doesn't recognise and it returns **200 OK**, quietly substituting `P0000000` (Tangible Personal
  Property, fully taxable). Nothing errors; you just overcharge every customer in every state that
  exempts the real category. The only tell is the `taxCode` echoed back on each response line.
  `createTransaction` now compares sent-vs-echoed per line, sets `degradedTaxCodes` on the result,
  and `console.error`s a loud `[avalara] TAX CODE REJECTED` — see [[../../../src/lib/avalara]].
  **Never add a tax code from memory. Verify it against `GET /api/v2/definitions/taxcodes` first.**
- **Verified codes we use** (checked against the definitions endpoint 2026-08-31):

  | Code | Avalara description | Ours |
  |---|---|---|
  | `PF050700` | Food And Food Ingredients-dietary supplements (supplement facts on label) | Superfood Tabs, Creatine Prime+, Ashwavana Zen Relax / Guru Focus, ACV Gummies, Sleep Gummies |
  | `PF050002` | Food And Food Ingredients - Food for Home Consumption or Basic Groceries | Amazing Coffee, K-Cups, Amazing Creamer |
  | `P0000000` | Tangible Personal Property | mugs, tumblers, mixers — and the workspace default |
  | `OS010100` | Shipping insurance / protection | Shipping Protection |
  | `FR020000` | Freight | the shipping line |

  `PF050700` is exempt in NY/TX and taxable in CA — correct per-jurisdiction behaviour, not a
  blanket exemption. That variation is how you tell a real code from a convenient one.
- **The workspace default is deliberately `P0000000` (fully taxable).** An unclassified product must
  fall back to taxable, never inherit an exemption it may not be entitled to.
- **2026-08-31 incident.** We shipped `PF050144` for every supplement (does not exist → degraded to
  `P0000000`) and `PC040100` for coffee (that code is **Clothing And Related Products**, so coffee was
  taking a clothing exemption). Supplements were overcharged sales tax in every exempting state for
  months. It surfaced only because Laura Light (ticket `295cc934`) insisted three times that NY
  doesn't tax supplements — two AI turns and a CS Director escalation all failed to check the code
  itself. Fixed in [[../../../src/lib/avalara-tax-codes]] + a data correction on `products`.
- **Tax codes resolve per line**, preferring `product_variants.shopify_tax_code`, then
  `products.avalara_tax_code`, then `workspaces.avalara_default_tax_code` — assembled in
  [[../../../src/lib/avalara-cart]] `buildAvalaraLines`, which every caller goes through.
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
