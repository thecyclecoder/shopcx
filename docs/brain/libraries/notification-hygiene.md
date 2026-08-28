# notification-hygiene

Gives informational notifications a terminal state a **human doesn't have to reach**.

**Code:** `src/lib/notification-hygiene.ts` · **Cron:** `src/lib/inngest/notification-hygiene.ts`
(`notification-hygiene-cron`, daily `0 9 * * *`, owner `platform`) · Owner: [[../functions/platform]]

## ⭐ The problem it fixes (measured 2026-08-28)

[[../tables/dashboard_notifications]] held **2,237 undismissed rows against 13 real decisions** — and
the pile was **not being ignored**:

| type | open | ever dismissed | oldest |
|---|---|---|---|
| `agent_approval_request` | 13 | **100%** (5,230 lifetime) | — |
| `fraud_alert` | 609 | **0%** | 2026-04-14 |
| `agent_daily_summary` | 269 | **0%** | 2026-06-24 |
| `chargeback_alert` | 136 | **0%** | 2026-03-27 |
| `system` | 1,186 | 24% | 2026-03-27 |

**98-100% of those rows were already `read`.** People open them and leave them, because dismissing
accomplishes nothing when there is no decision to make. The only exit from the inbox is a manual
click, so anything informational accrues forever **by construction** — ~31/day since March.

Contrast `agent_approval_request`: 5,230 lifetime, 100% dismissed. *A surface with real decisions
gets worked. A surface of log lines does not, and never will.*

## The principle

> Every notification type needs a terminal state that something **other than a human** can reach — a
> timer, a linked record resolving, or a supersede. If the only exit is a click, the type is a log
> and does not belong in an inbox.

## What it sweeps

| sweep | terminal condition | why not a timer |
|---|---|---|
| `sweepExpiredReports` | age > `DAILY_SUMMARY_TTL_DAYS` (7) | a report has no linked record; age is the only honest condition |
| `sweepSettledChargebacks` | linked [[../tables/chargeback_events]] row is `won`/`lost`/`closed`/`accepted` OR has `finalized_on` | **a live dispute carries an `evidence_due_by` deadline** — sweeping it on age would hide a real one |

First run: **239 recaps + 134 settled chargebacks retired; 2 kept.** Both kept rows were
`under_review` with live deadlines — which is the sweep working, not failing.

> ⚠️ That first run surfaced a real finding it deliberately did NOT hide: a `product_unacceptable`
> dispute for **$123.01**, still `under_review`, whose `evidence_due_by` was **2026-08-23** — five
> days past due. Being selective is what made it visible.

## What it deliberately does NOT sweep

- **`fraud_alert`** — the problem there is *granularity*, not retention. One order (#7141) fired at
  least three alerts, at LOW/MEDIUM severity, with no action attached. That needs aggregation and a
  severity routing decision (a product call), not a TTL.
- **`system`** — mixed: some rows carry an actionable `job_id`, some are pure information under the
  same type. Splitting the actionable ones out is the prerequisite to anything sensible.
- **Any chargeback whose ledger row cannot be resolved.** An unresolvable `metadata.entity_id` is
  left alone. We only retire a pointer when we can SEE the thing it points at has finished —
  guessing is what put a phantom card in the CEO inbox the same day
  ([[media-buyer-cold-scaler-graduate-heartbeat]]).

## Purity

`isExpiredReport` and `isChargebackSettled` are pure and exported, so both boundaries are testable
without a clock or a DB. An unparseable date and a missing ledger row both resolve to "do not
sweep" — the sweep fails toward keeping. Pinned in `src/lib/notification-hygiene.test.ts`.

Run it manually with `scripts/_run-notif-hygiene.ts` (dry by default; prints what it would KEEP,
which is the part worth reading).

---

[[../README]] · [[../../CLAUDE]]
