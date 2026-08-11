# qb-close/gateway-amounts.ts

Resolves the **actual captured amount per gateway** on split-payment Shopify orders, so the journal entry's clearing debits land on the accounts that really received the money. Owner: [[../functions/cfo]] (Grace). Consumed by [[qb-close-run]] and `_shopcx-close-dryrun.ts`.

## ⭐ `payment_gateway_names` lists gateways ATTEMPTED, not gateways that captured

That distinction is the whole module. The JE previously divided an order's total **equally** among every listed gateway (a "rare case" fallback), which credits clearing accounts that received nothing.

Order `SC134526` (2026-07) is the clearest case: three gateways listed — `braintree + shopify_payments + PayPal Braintree` — and a **single one captured the entire $263.51**. The equal split invented $175.67 of clearing debits across two accounts that took $0.00.

Measured across July 2026's 12 split-payment orders:

| Gateway | Equal-split | Actual | Error |
|---|---|---|---|
| shopify_payments | $664.25 | **$976.23** | −$311.98 |
| braintree | $214.63 | **$0.00** | +$214.63 |
| PayPal Braintree | $535.13 | $477.16 | +$57.97 |
| shopify_store_credit | $83.91 | $48.77 | +$35.13 |
| shop_cash | $89.05 | $60.00 | +$29.05 |
| paypal | $24.80 | $49.60 | −$24.80 |

**$1,540.23 of absolute misallocation.** Braintree was credited $214.63 having captured nothing at all.

## Result

With real splits applied, `Clearing:Braintree` lands on **$21,070.52** — **exactly** the month's true Braintree processor gross. Shopify Payments improves from −0.6% to −0.4%.

## API

```ts
annotateGatewayAmounts(orders, shopDomain, accessToken): Promise<{ resolved, failed, correction }>
```

Mutates `order.gateway_amounts` in place (orders are request-scoped) and returns what changed, so a caller can **report** the correction rather than applying a silent adjustment to the books.

Reads `/orders/{id}/transactions.json`, counting only `kind ∈ {sale, capture}` with `status === "success"` — authorizations and voids never moved money.

## Cost

Only orders with **more than one gateway** need the call — 12 of 2,048 in July. A single-gateway order's total already belongs entirely to that gateway, so it is skipped and costs nothing.

## Gotchas

- **The builder keeps the equal-split fallback** ([[qb-close-journal-entry]] `gateway_amounts` absent). It is correct for single-gateway orders — >99% of them — and is the documented wrong answer for the rest. A caller that forgets to annotate degrades quietly, so `resolved`/`failed` are surfaced in the close route's warnings.
- **Zero captured → leave the order alone.** An empty map would drop the order's gross from every clearing account entirely, which is worse than an approximate split. Counted as `failed`.
- Two gateways mapping to the SAME processor (`braintree` + `PayPal Braintree`) must accumulate, not overwrite — pinned by test.
- Any harness that rebuilds the JE must annotate too, or it measures the fallback rather than what the close builds. `_verify-clearing-reconciliation.ts` was doing exactly that until it was fixed.

## Tests

`src/lib/qb-close/journal-entry.gateway-split.test.ts` — 5 cases including the real SC134526 shape. Run: `npx tsx --test src/lib/qb-close/journal-entry.gateway-split.test.ts`.

## Related

[[qb-close-journal-entry]] · [[qb-close-run]] · [[qb-close-sync-processors]] · [[../tables/qb_payment_processor_summaries]]
