# qb-close/sync-processors.ts

The month's per-processor money rollup into [[../tables/qb_payment_processor_summaries]] — the journal entry's fee / refund / chargeback / clearing-net-down block. Owner: [[../functions/cfo]] (Grace).

> **🚧 NOT YET WIRED INTO THE DAILY CRON.** All three processors run, but none reconciles to the golden figures yet (below). `qb_payment_processor_summaries` is still populated by `scripts/_backfill-qb-close-sources.ts`. Wiring an unreconciled sync in would overwrite known-good rows with plausible wrong ones — which happened twice while testing.

## Reconciliation status (2026-07)

| Processor | Status | vs golden |
|---|---|---|
| `braintree` | runs | refunds **$576.78 ✓ exact** · chargebacks **$0.00 ✓** · gross $21,070.52 vs $20,320.61 (**+3.7%**) |
| `paypal` | runs | gross $33,023.51 vs $31,166.36 (**+6.0%**) · fees $1,057.50 vs $1,001.92 |
| `shopify_payments` | **403** | needs the `read_shopify_payments_payouts` scope |

The two gross overstatements are almost certainly transaction classification (which statuses/event codes count as gross), not a fetch problem — refunds and chargebacks landing exactly right on Braintree points at the same data being read correctly and bucketed differently.

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
