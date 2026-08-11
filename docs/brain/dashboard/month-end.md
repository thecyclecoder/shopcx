# /dashboard/month-end

The operator surface for the QuickBooks month-end close. Owner: [[../functions/cfo]] (Grace). Calls `/api/qb/month-end-closing` ([[../libraries/qb-close-run]]).

**Menu placement:** under **Logistics**, next to Mappings and Inventory — the pages backing exactly the tables the close reads. It is CFO-owned work cross-listed there rather than given its own section for a single page.

## Design principle: the safe action is the easy one

"Run dry run" is the primary button and writes nothing. Posting is secondary, **disabled until the guard passes**, and requires typing the month to confirm. That asymmetry is deliberate — the InventoryAdjustment and the three SalesReceipts have no void and no dedup, so a mis-click is not recoverable.

The month selector defaults to the most recently **elapsed** month; the API refuses a month that hasn't ended.

## What it shows

| Panel | Content |
|---|---|
| Eligibility | already-closed · eligible (with the proving dry-run timestamp) · or the refusal reason |
| Guard verdict | pass, or every blocking issue with its `code` + detail — all at once, not one per run |
| Summary tiles | JE total + balanced state · adjustment line count · receipt units per channel · Shopify order count |
| Steps | per-step status from the executor (shadow runs show a single `shadow` row) |
| Warnings | notably the `staleWindow` alert when Shopify's 60-day order window has clipped the month |

## Braintree fees

Braintree's API reports only an **estimate (~58%)** — card-network assessments post around the 5th, so the real figure comes off the statement and is entered by hand. Saving it `PATCH`es `qb_payment_processor_summaries.processing_fees`, which moves both the txn-fee debit and the clearing net-down credit.

If the month's JournalEntry is already posted it is **updated in place** (Id + SyncToken). That is safe only because the JE is the one idempotent artifact — the adjustment and receipts are deliberately untouched. If the rebuilt JE doesn't balance, the posted one is left alone and the response says so.

## Gotchas

- A dry run **appends** to [[../tables/qb_close_dry_runs]] and the guard reads the LATEST. A diagnostic run that fails therefore makes the month ineligible until a passing run replaces it.
- `staleWindow` is silent when clean — silence means the window is fine, not that it wasn't checked.
- The page is workspace-scoped via `useWorkspace()`; the API requires an explicit `workspace_id`.

## Related

[[../libraries/qb-close-run]] · [[../libraries/qb-close-guard]] · [[../tables/qb_month_end_closings]] · [[../lifecycles/shoptics-migration]]
