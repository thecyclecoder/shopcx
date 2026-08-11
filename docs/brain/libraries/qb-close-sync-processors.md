# qb-close/sync-processors.ts

The month's per-processor money rollup into [[../tables/qb_payment_processor_summaries]] — the journal entry's fee / refund / chargeback / clearing-net-down block. Owner: [[../functions/cfo]] (Grace).

> **⭐ The stored July figures are NOT a valid comparison target.** Shoptics' `payment_processor_summaries` rows for 2026-07 carry `synced_at = 2026-07-31 08:01 UTC` — captured **16 hours before the month ended**, by the daily `processor-snapshot` cron (`0 8 * * *`). They are a month-to-date snapshot, not a final figure. The close does **not** use them: step 8 re-runs `sync-processors` for the month before building the JE. Comparing a fresh pull against that snapshot makes a correct sync look 4–6% high.

## Reconciliation status (2026-07)

| Processor | Status | vs the 07-31 08:01 snapshot |
|---|---|---|
| `braintree` | ✅ reconciled | refunds **$576.78 exact** · chargebacks **$0.00 exact** · gross +$749.91, of which **$617.84 (82%) is settlement after the snapshot instant**; residual $132.07 (0.65%) |
| `paypal` | ✅ same shape | gross +5.7%, fees +5.5% — same cause (fees are summed only on sales, so they track gross) |
| `shopify_payments` | ✅ **EXACT** | gross / fees / refunds / chargebacks all **$0.00 delta** — matches golden to the cent |

Proven by cutting a fresh Braintree pull at shoptics' capture instant: full July gross $21,070.52 → $20,452.68 when restricted to `settledAt <= 2026-07-31T08:01:29Z`, against the stored $20,320.61.

**Implication: a fresh pull is MORE complete than the stored snapshot, not wrong.** Late-settling transactions are real July revenue.

**Shopify Payments corroborates this independently.** It reconciles to **$0.00 on all four figures** — because payouts are *settled* by definition and do not move after capture. PayPal and Braintree differ only in the direction and magnitude that late settlement predicts. Same code path, different settlement behaviour.

Scope note: ShopCX's token carries BOTH `read_shopify_payments_payouts` (granted 2026-08-11, app version `shopcx-100`) and `read_all_orders`. Shoptics has the former but NOT the latter — which is why the ~60-day order-window deadline binds Shoptics and not the ShopCX close.

## Exports

`syncShopifyPaymentsSummary` · `syncPaypalSummary` · `syncBraintreeSummary` · `syncProcessorSummaries` (all three, isolated).

## ⭐ Never blank a row on failure

A **missing** row silently drops that processor's whole block from the JE, which then cannot balance. A **zeroed** row is worse — it balances while being wrong. Every sync either writes real figures or leaves the existing row untouched and reports `error`; [[qb-close-guard]] blocks the close on `missing_processor_summaries`.

## ⚠️ Braintree fees are not derivable and are never guessed

Braintree reports only a partial figure (~58% of eventual) because card-network assessments post around the 5th; the true number exists only on the statement. This module writes gross / refunds / chargebacks and **carries `processing_fees` forward untouched** — the founder enters the statement figure on [[../dashboard/month-end]], which rewrites it and rebuilds the JE.

An earlier draft of this file computed `gross × 0.0058` as an "estimate". That was fiction — July's actual was $313.27 on $20,320.61 gross (1.54%) — and it is exactly the failure mode to avoid: a plausible wrong number that balances. `raw_payload.fee_source` records `manual_override` \| `carried_forward` \| `unset` so the provenance is never ambiguous.

## PayPal needs its own credentials

Two layers get conflated. The **gateway** on an order may be `paypal` (356 Shopify orders in July) or `PayPal Braintree` (158, mapped → braintree) — that drives the clearing DEBIT from the order side. The **processor rollup** comes from PayPal's own `/v1/reporting/transactions`, because PayPal settles into PayPal and its fees never appear in Shopify's payout summaries. July's PayPal block is real money ($31,166.36 gross / $1,001.92 fees).

Credentials live on `workspaces.paypal_client_id` / `paypal_client_secret_encrypted` / `paypal_environment` (migration `20261213140000`, secret AES-256-GCM), copied from Shoptics by `scripts/_backfill-paypal-credentials.ts`.

## Gotchas

- **Braintree range fields are ACCESSOR FUNCTIONS.** `search.settledAt.between(...)` compiles under the shipped typings and throws *"is not a function"* at runtime — it must be `search.settledAt().between(from, to)`. Same for dispute `receivedDate()`.
- Shopify Payments aggregates **paid payout summaries**, not order amounts — fees, refund fees and dispute fees are only broken out there. Shopify calls chargebacks `adjustments_gross_amount`.
- ShopCX's Shopify token currently lacks `read_shopify_payments_payouts` (it has `read_shopify_payments_disputes`). Granting it is a Shopify-admin scope change plus re-auth.

## Related

[[qb-close-sync-sources]] · [[qb-close-guard]] · [[../tables/qb_payment_processor_summaries]] · [[../dashboard/month-end]]
