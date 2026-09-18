# inngest/shopcx-drift-reconcile

Daily row-vs-contract drift check for ShopCX-billed subscriptions.
**File:** `src/lib/inngest/shopcx-drift-reconcile.ts` · logic:
[[../libraries/commerce__shopcx-drift-reconciler]].

## ⭐ Supervisable autonomy, applied to a money path

The renewal worker is an autonomous tool optimizing a bounded proxy: *charge what our row says is
due*. When our row and the Shopify contract disagree, that proxy quietly stops tracking the real
objective — a customer who is not actually subscribed keeps being "renewed" at, or a live subscriber
is never charged again — and **nothing in the charge path errors**. This cron is the supervisor that
makes that visible. See [[../operational-rules]] § North star.

## Function

### `shopcx-drift-reconcile-cron`
- **Trigger:** cron `0 8 * * *` — **two hours before** the renewal cron (`0 10 * * *`), so a strand
  found today is reported before today's charges run rather than after
- **Retries:** 1 · **Concurrency:** `{ limit: 1 }`
- **Steps:** kill-switch → list workspaces → one `reconcileShopcxDrift(ws, {apply:true})` step per
  workspace → heartbeat
- **Heartbeat:** `emitCronHeartbeat` on every run including the switched-off path, carrying
  `{checked, repaired, stranded, date, status}` so the counts are visible in Control Tower without
  reading logs

`stranded` rows are logged individually at `console.error` — they are the only kind that silently
stops a live customer being charged, so they are named one by one rather than counted.

## Tables written

- [[../tables/subscriptions]] — status repair only (`status`, `cancelled_at`, `next_billing_date`)

## Tables read (not written)

- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
