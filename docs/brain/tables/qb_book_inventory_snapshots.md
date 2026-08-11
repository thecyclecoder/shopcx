# qb_book_inventory_snapshots

What **QuickBooks itself** held per item, captured before and after each close (steps 1 and 6). The `month_end_post` row for month *M* is the **opening book** for month *M+1* — the `qb_starting` term in the inventory audit. Owner: [[../functions/cfo]] (Grace). Read by [[../libraries/qb-close-month-end]].

> **Distinct from [[inventory_snapshots]].** That table is ShopCX's own physical/logistics view (location · on_hand · inbound per SKU-day). This one is the **book** value from QuickBooks. They answer different questions and must never be conflated — which is why this table is `qb_`-prefixed.

**Primary key:** `id` · **Lookup index:** `(workspace_id, closing_month, snapshot_type)`

## Columns

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` | PK |
| `workspace_id` | `uuid` | NOT NULL · → [[workspaces]].id · CASCADE |
| `product_id` | `uuid` | NOT NULL · → [[qb_items]].id · CASCADE |
| `source` | `text` | default `quickbooks` |
| `quantity` | `numeric` | QB `QtyOnHand`, floored to whole units at capture |
| `snapshot_type` | `text?` | `month_end_pre` \| `month_end_post` |
| `closing_month` | `text?` | `'YYYY-MM'` the snapshot belongs to |
| `snapshot_at` | `timestamptz` | when captured — **not** the month end; the close often runs days later |
| `raw_payload` | `jsonb?` | the QB Item payload |

## Why post-close equals physical

The close writes QB up to the measured physical count before the sales receipts are posted, so after step 6:

```
QB_after = physical(period end)
```

which is what makes it a valid opening book for the next month. Concretely: adjustment = `physical − (prior_book − sold + received)`, so `QB = prior_book + received + adjustment = physical + sold`, and the receipts then deduct `sold`.

## Gotchas

- **⭐ A missing opening book does not error — it reads as zero,** and every item then looks like a total loss. `buildMonthEndArtifacts` surfaces `meta.qbBasisRows`; assert it. July 2026 expects **86** rows from `2026-06 / month_end_post` (2,139,297 units). An early ShopCX run showed `0 rows` and produced a 1,097,674-unit adjustment.
- `snapshot_at` lags the period end (June's post-close snapshot was taken 2026-07-07). That is correct — QB is only decremented by the monthly receipts, so the July-7 reading still represents end-of-June book.
- Row counts differ by month (June 172 = 86 pre + 86 post; May 86). Do not assume a fixed count.
- There is no natural unique key — a month can legitimately be re-snapshotted — so backfills **delete the `(workspace, closing_month)` slice** before inserting rather than upserting.

## Related

[[inventory_snapshots]] · [[qb_items]] · [[qb_month_end_closings]] · [[../libraries/qb-close-month-end]]
