# qb-snapshot-refresh

`src/lib/inngest/qb-snapshot-refresh.ts` — the monthly QuickBooks P&L freshness job. Re-pulls the **trailing 6 closed months** for every QuickBooks-connected workspace and upserts each [[../tables/qb_pnl_snapshots]] row in place.

## Why 6 months, why the 16th

- **The ~15th close.** Last month's books don't finish closing in QuickBooks (month-end inventory/COGS entries) until ~the 15th. Running on the **16th** means the newest month is final.
- **Late entries mutate history.** Entries post after the fact and change already-closed months, so every pull re-grabs the trailing 6 (not just the newest) — a month keeps getting corrected for ~6 months, then ages out. `QB_REFRESH_MONTHS = 6`.

## Triggers

- **`cron: "0 8 16 * *"`** — the 16th, 8am UTC.
- **`event: "qb/refresh-snapshots"`** — manual. Optional `data`: `{ workspaceId?, months? }`.

## What it does

For each workspace in `quickbooks_connections` (or `data.workspaceId`): `backfillPnlSnapshots(ws.id, 6)` ([[../libraries/quickbooks]]) — re-pull + upsert the last 6 closed months (all columns, incl. the variable-cost breakout, since `snapshotPnlMonth` writes the full rollups). Per-workspace errors are collected, not fatal. Ends with a Control Tower heartbeat.

Returns `{ workspaces, monthsRefreshed, errors }`.

## Relationship to the investor send

[[investor-monthly-invite]] (the 20th) **also** runs the same trailing-6 refresh as its first per-workspace step (belt-and-suspenders — guarantees the report is fresh even if the 16th job failed). This 16th job keeps the CFO dashboard fresh independent of the investor email.

## Registered

`qbSnapshotRefresh` in `src/lib/inngest/registered-functions.ts`.

## Control Tower monitoring

`src/lib/control-tower/registry.ts` — monitored as a cron with:
- **id:** `"qb-snapshot-refresh"`
- **kind:** `"cron"`
- **owner:** `"platform"`
- **expectedCadence:** `"monthly (0 8 16 * *)"`
- **livenessWindowMs:** `32 * DAY` (32-day grace for monthly cadence)
- **registeredAt:** `"2026-07-10T16:15:05.195Z"`

Liveness monitoring surfaces stale or failed monthly refreshes via [[../dashboard/control-tower]].

## Related

[[../tables/qb_pnl_snapshots]] · [[../libraries/quickbooks]] · [[investor-monthly-invite]] · [[../lifecycles/investors-area]] · [[monthly-revenue-snapshot]]
