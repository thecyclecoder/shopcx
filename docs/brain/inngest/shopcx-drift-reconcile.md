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

## ⭐ It ESCALATES now — a monitor that only logs is not a monitor

Every defect in the ShopCX subscription subsystem through 2026-09-30 was found because a **human
asked "check on things"**. The cron logged perfectly, and nothing read the logs. Four separate
customer-affecting bugs — stranded subs, frozen dunning dates, silently dropped discounts, a month of
delay — all sat in green dashboards until somebody went looking.

So anything non-zero now opens a `repair` job via [[../libraries/repair-agent]] `enqueueRepairJob`,
deduped by a stable signature so a persisting condition does not re-open one daily.

## ⭐ Three checks, because one cannot see what the others miss

| Check | Question it asks | What it alone would miss |
|---|---|---|
| `status` | does our row agree with the contract? | a correct row on a broken schedule |
| `stranded` | does our date land in a spent cycle? | a date in a valid cycle at the wrong end of it |
| **`late`** (`findLateSubscriptions`) | is the next charge later than one cadence after the last? | nothing about schedule mechanics — it is the customer's view |

The third exists because **22 subs were a month late on 2026-09-28 while the first two read green**.
A subscription can sit in a correct, unbilled cycle and still be pinned to the far end of its window.
The customer's own cadence is the only honest reference.

### ⚠️ Only OUR lateness pages anyone

`late` is split three ways, and just one of them escalates:

- **held by an open dunning cycle** — the date is held on purpose; expected, never escalated.
- **inherited** — the last charge predates `migration_completed_at`, so the sub arrived already
  behind. 7 of 13 on 2026-09-30, last charged April–August, before we ever billed them.
- **caused by us** — everything else. This is the only group that opens a repair job.

Escalating the first two would fire daily forever and train everyone to ignore the alert — and the
one that mattered would go with it. That split is what makes the alert worth reading.

## Verified 2026-10-01 — and the heartbeat proved the point

Heartbeats read back from [[../tables/loop_heartbeats]] (`loop_id = 'shopcx-drift-reconcile-cron'`):

```
2026-10-01 08:02  checked 212  stranded 0  date 0  status 0  late 0  lateInDunning 6  lateInherited 9
2026-09-30 08:01  checked 209  stranded 3
2026-09-29 08:01  checked 209  stranded 0
```

**The 09-30 beat is the whole argument for this page.** The cron *detected* 3 stranded subscriptions
at 08:01 — hours before a human found them by hand — and had no way to tell anyone. Detection was
never the gap. Escalation was.

### The alert path is tested, not assumed

`enqueueRepairJob` was exercised end to end with a throwaway signature: the job was created, the box
picked it up within seconds (`status=building`), a second call was correctly refused
(`live repair job exists for this signature`, so a persisting condition will not re-open one daily),
and the test row was deleted with no stray branch or PR left behind.

⚠️ **A monitor whose alert path has never fired is only half-built.** Worth re-testing the same way
after any change to the escalation wiring.

## Tables written

- [[../tables/subscriptions]] — status repair only (`status`, `cancelled_at`, `next_billing_date`)

## Tables read (not written)

- [[../tables/workspaces]]

---

[[../README]] · [[../integrations/inngest]] · [[../../CLAUDE]]
