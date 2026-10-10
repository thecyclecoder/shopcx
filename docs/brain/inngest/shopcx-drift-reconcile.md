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
- **Trigger:** cron `0 8 * * *` — **two hours before** the renewal cron (`0 10 * * *`), so any
  drift found today is reported before today's charges run rather than after
- **Retries:** 1 · **Concurrency:** `{ limit: 1 }`
- **Steps:** kill-switch → list workspaces → one `reconcileShopcxDrift(ws, {apply:true})` step per
  workspace → cadence-check (`findLateSubscriptions`) → escalate-if-needed → heartbeat
- **Heartbeat:** `emitCronHeartbeat` on every run including the switched-off path, carrying
  `{checked, repaired, date, status, late, lateInDunning, lateInherited}` so the counts are visible in Control Tower without
  reading logs

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
| `date` | does our date differ from Shopify's `nextBillingDate`? | a date-only display mismatch (not a charge blocker) |
| **`late`** (`findLateSubscriptions`) | is the next charge later than one cadence after the last? | nothing about schedule mechanics — it is the customer's view |

The third exists because **22 subs were a month late on 2026-09-28 while the first two read green**.
A subscription can sit in a correct, unbilled cycle and still be pinned to the far end of its window.
The customer's own cadence is the only honest reference.

⭐ **`stranded` is RETIRED** (Phase 1, 2026-10-09) — it used to flag a date landing in a spent cycle,
because the old renewal worker resolved cycles by date and skipped already-billed ones. With
[[../libraries/commerce__shopify-subscription-client]] `resolveChargeableCycle`, the renewal worker now bills the first
UNBILLED cycle by **index**, so a spent cycle no longer blocks a charge. There is nothing to strand, no
per-row `getBillingCycleForDate` probe, and the stranded escalation path (which was finding nothing
meaningful and training operators to ignore alerts) is retired.

### ⚠️ Only OUR lateness pages anyone

`late` is split three ways, and just one of them escalates:

- **explained by dunning** — the current cycle went through dunning, so the late date is dunning-owned,
  not scheduling drift; expected, never escalated. This covers both the *open* states
  (`active`/`rotating`/`retrying`/`skipped`/`paused`) and the *terminal* outcomes (`exhausted`/`recovered`)
  — see `DUNNING_STATUSES_EXPLAINING_LATENESS` in `src/lib/commerce/shopcx-drift-reconciler.ts`. The
  terminal states were originally missing, so an exhausted-dunning failed-card sub was mis-paged as drift.
- **inherited** — the last charge predates `migration_completed_at`, so the sub arrived already
  behind. 7 of 13 on 2026-09-30, last charged April–August, before we ever billed them.
- **caused by us** — everything else. This is the only group that opens a repair job.

Escalating the first two would fire daily forever and train everyone to ignore the alert — and the
one that mattered would go with it. That split is what makes the alert worth reading.

## Verified 2026-10-01 — and the heartbeat proved the point

Heartbeats read back from [[../tables/loop_heartbeats]] (`loop_id = 'shopcx-drift-reconcile-cron'`):

```
2026-10-01 08:02  checked 212  repaired 0  date 0  status 0  late 0  lateInDunning 6  lateInherited 9
2026-09-30 08:01  checked 209  repaired 0  date 0  status 0  late 3  lateInDunning 2  lateInherited 8
```

**The 09-30 beat is the whole argument for this page.** The cron *detected* 3 subscriptions over-late
by their own cadence at 08:01 — hours before a human found them by hand — and had no way to tell anyone. 
Detection was never the gap. Escalation was. (Historical data from 2026-09-30 showed "stranded 3", but
that `stranded` field was retired in Phase 1 as the probe became obsolete.)

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
