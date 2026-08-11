# qb_payment_processor_summaries

Per-processor, per-closing-month money rollup — the journal entry's fees / refunds / chargebacks / clearing-net-down block. Owner: [[../functions/cfo]] (Grace). Read by [[../libraries/qb-close-month-end]] and `qb-close/journal-entry.ts`.

**Primary key:** `id` · **Unique:** `(workspace_id, closing_month, processor)`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · CASCADE |
| `closing_month` | `text` | NOT NULL · `'YYYY-MM'` |
| `processor` | `text` | NOT NULL · `shopify_payments` \| `paypal` \| `braintree` |
| `gross_sales` | `numeric` | processor-reported gross |
| `processing_fees` | `numeric` | → Debit the processor's txn-fee account |
| `refunds` | `numeric` | → Debit Contra Income:Refunds |
| `chargebacks` | `numeric` | → Debit Contra Income:Chargebacks |
| `adjustments` | `numeric` | |
| `net_deposits` | `numeric` | |
| `raw_payload` | `jsonb?` | processor API response |
| `synced_at` | `timestamptz` | |

## How the JE consumes it

Per processor: Debit `processing_fees` to the txn-fee account, Debit refunds and chargebacks to their contra-income accounts, then **Credit the clearing account by the summed deductions**:

```
clearing_credit = round2(fees + refunds + chargebacks)
```

The matching clearing **Debit** is the *order gross by gateway*, which comes from the Shopify orders — not from this table. This split is why, when the July 2026 JE drifted, the fee/refund/chargeback lines held steady while every order-derived line moved: it isolated the fault to the order fetch.

## Gotchas

- **This is the monthly summary** — window-immune, unlike the order-derived half of the JE. Revenue, tax, shipping, discounts and clearing debits all come from live Shopify orders and are subject to the 60-day scope wall; these rows are not.
- **Braintree fees are ~58% estimated** (card-network assessments post around the 5th). The month-end UI exposes an editable override which writes back to `processing_fees`.
- `gross_sales` here is the **processor's** figure and will not equal the order-derived clearing debit; they are different bases and are not expected to tie by inspection.
- Missing rows for a month do not error — the JE simply omits that processor's block and will not balance. Check all three exist before closing.

## Related

[[../libraries/qb-close-month-end]] · [[qb_month_end_closings]] · [[../lifecycles/shoptics-migration]]
