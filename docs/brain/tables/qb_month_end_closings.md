# qb_month_end_closings

The close ledger — one row per closed month, recording every QBO artifact posted and the variance verdict. **`(workspace_id, closing_month)` is UNIQUE: this is the run-once guard.** Owner: [[../functions/cfo]] (Grace). Written by the close route; read by [[../libraries/qb-close-month-end]] callers.

**Primary key:** `id` · **Unique:** `(workspace_id, closing_month)`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · CASCADE |
| `closing_month` | `text` | NOT NULL · `'YYYY-MM'` |
| `status` | `text` | `running` \| `completed` \| `completed_with_errors` \| `error` |
| `pre_snapshot_at` / `post_snapshot_at` | `timestamptz?` | steps 1 and 6 |
| `inventory_adjustment_id` | `text?` | QBO id (step 2) |
| `amazon_receipt_id` / `_doc` | `text?` | step 3 · doc `AMZ-MM-YYYY` |
| `shopify_receipt_id` / `_doc` | `text?` | step 4 · doc `SHOP-MM-YYYY` |
| `internal_receipt_id` / `_doc` | `text?` | step 5 · doc `INT-MM-YYYY` |
| `shopify_journal_entry_id` / `_doc` | `text?` | step 8 · doc `SHOPIFY-MMYY` |
| `variance_check_passed` | `boolean?` | step 7 · true iff `Σ|diff| == 0` |
| `variance_details` | `jsonb?` | `[{name, variance}]` when non-zero |
| `error_message` | `text?` | |
| `started_at` / `completed_at` / `created_at` | `timestamptz` | |

## ⭐ Why run-once is enforced in the schema

The JournalEntry **is** idempotent (updated in place by stored id + SyncToken). The **InventoryAdjustment and the three SalesReceipts are NOT** — there is no void or dedup, so re-running a month duplicates real QBO documents and corrupts inventory. The unique constraint is the last line of defence; the posting path must also refuse when a completed row exists.

## Reading `completed_with_errors`

Historically the normal terminal state, and usually benign. Every Shoptics close from 2026-03 to 2026-06 ended this way with a single `variance_details` entry: `Bulk - Amazing Coffee - Cocoa`, variance −0.2 / −0.2 / 0.8 / 0.4. That item carries a fractional multi-parent BOM quantity (×0.2), so its variance cannot round to a whole `QtyDiff` and step 7 can never reach exactly zero.

Do **not** treat that as a failed close — but do read `variance_details` rather than assuming, because a genuinely bad close looks identical at the `status` level.

## Historical adjustment magnitudes (sanity band)

| Month | Posted adjustment $ | Abs units |
|---|---|---|
| 2026-03 | $27,358 | 82,973 |
| 2026-04 | $8,406 | 19,489 |
| 2026-05 | $2,055 | 2,634 |
| 2026-06 | $3,285 | 2,615 |

A close landing far outside the recent band is a signal to investigate inputs, not to post. The July 2026 dry run first produced **$85,864** — entirely from bad inputs, not real shrinkage.

## Related

[[qb_book_inventory_snapshots]] · [[qb_payment_processor_summaries]] · [[../libraries/qb-close-month-end]] · [[../lifecycles/shoptics-migration]]
