# qb-close/run-close.ts

The 8-step month-end close executor, plus its route `POST /api/qb/month-end-closing`. Owner: [[../functions/cfo]] (Grace). Computes via [[qb-close-month-end]], gated by [[qb-close-guard]], writes [[../tables/qb_month_end_closings]] + [[../tables/qb_book_inventory_snapshots]].

> **Shadow by default.** `mode: 'shadow'` computes all 5 artifacts, records a dry-run verdict, and writes NOTHING to QuickBooks. Posting requires an explicit `post: true` **and** `assertPostable` allowing it.

## The 8 steps

| # | Step | QBO |
|---|---|---|
| 1 | QB inventory snapshot (pre) | read |
| 2 | InventoryAdjustment → shrinkage | `POST inventoryadjustment` (whole-unit `QtyDiff`) |
| 3 | Amazon $0 SalesReceipt (COGS) | `POST salesreceipt` |
| 4 | Shopify $0 SalesReceipt | `POST salesreceipt` |
| 5 | Internal $0 SalesReceipt | `POST salesreceipt` |
| 6 | QB inventory snapshot (post) | read |
| 7 | Variance check | DB only |
| 8 | JournalEntry | `POST journalentry` |

## ⭐ Ordering is load-bearing

Step 2 trues QuickBooks up to measured physical, **then** 3–5 deduct the month's units. That sequence is what makes step 6 equal physical, which is what makes it a valid opening book for next month:

```
QB_after_adj = prior_book + received + variance = physical + sold
QB_after_receipts = physical
```

Reorder these and next month's `qb_starting` is wrong in a way nothing downstream can detect.

## ⭐ Run-once, enforced twice

Only the JournalEntry is idempotent (updated in place by id + SyncToken). The InventoryAdjustment and the three SalesReceipts have **no void and no dedup** — a second run duplicates real QuickBooks documents and corrupts inventory. So:

1. `assertPostable` refuses before any write, and
2. the `(workspace_id, closing_month)` UNIQUE on [[../tables/qb_month_end_closings]] makes a concurrent second close fail on the claim rather than halfway through posting.

Verified: a post attempt on an unproven month returns `refused` with **0 steps executed**.

## Route contract

| | |
|---|---|
| `POST` `{month, workspace_id}` | shadow run; records a dry-run verdict; `200` |
| `POST` `{month, workspace_id, post: true}` | live close; `409` + `refused` if the guard says no |
| `GET` `?month=&workspace_id=` | eligibility + latest verdict + closing row, runs nothing |

**Manual trigger only — deliberately not wired to any cron.** An automatic retry of a non-idempotent post is exactly the failure this design exists to prevent. Refuses a month that has not yet ended (no period-end physical to measure against).

## Step 7 — reading the variance check

Compares post-close QB **directly against the measured physical** the audit reported (`auditRows[].actual`). It deliberately does **not** re-run the audit formula (`QB start − sold + received`): QuickBooks has by then absorbed the adjustment and the receipts, so re-deriving would double-count them and manufacture a variance.

A *fractional* residual is expected and benign — an item with a fractional multi-parent BOM quantity (`Bulk - Amazing Coffee - Cocoa`, ×0.2) can never round to a whole `QtyDiff`, which is why every Shoptics close 2026-03…06 ended `completed_with_errors` on exactly that one item. Whole-unit residuals are the ones worth alarming on.

## Gotchas

- **The route surfaces a `staleWindow` warning** when Shopify returns no orders before the 1st. Without the `read_all_orders` scope the Admin API caps at ~60 trailing days, so a late close under-reports revenue **and still balances**. Silence here is not safety.
- Steps 3–5 and 8 **record-error-and-continue**; a failed receipt must not abort a close that has already posted an adjustment. The month lands `completed_with_errors`.
- Steps 1 and 6 REPLACE their `(month, snapshot_type)` slice rather than upserting — a month can legitimately be re-snapshotted.
- `fetchReceived` returns `ok` separately from the map. An empty map with `ok: false` means the query broke, not that nothing was received — the distinction that cost $67,131 in July.

## Related

[[qb-close-month-end]] · [[qb-close-guard]] · [[../tables/qb_month_end_closings]] · [[../tables/qb_close_dry_runs]] · [[../lifecycles/shoptics-migration]]
