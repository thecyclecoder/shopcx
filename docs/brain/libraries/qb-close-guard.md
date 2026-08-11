# qb-close/close-guard.ts

Decides whether a month-end close may **post**, and grades a dry run. Owner: [[../functions/cfo]] (Grace). Reads [[../tables/qb_month_end_closings]] + [[../tables/qb_close_dry_runs]]; graded inputs come from [[qb-close-month-end]].

> **Why a guard at all.** The JournalEntry is idempotent (updated in place by stored id + SyncToken). The **InventoryAdjustment and the three SalesReceipts are NOT** — no void, no dedup — so a second run duplicates real QuickBooks documents and corrupts inventory. This module exists to make posting twice, or posting off bad inputs, structurally impossible rather than merely discouraged.

## Exports

| Export | Purpose |
|---|---|
| `assessDryRun(input)` | Grade a computed month. Returns `{ passed, blocking[], warnings[], jeBalanced, inputHealth }` |
| `assertPostable(admin, ws, month)` | May this month post? `{ allowed, reason?, provenAt? }` |
| `recordDryRun(...)` | Append the verdict to [[../tables/qb_close_dry_runs]] |
| `JE_BALANCE_TOLERANCE` | `0.01` — QuickBooks rejects anything looser |
| `REQUIRED_PROCESSORS` | `shopify_payments · paypal · braintree` |

## ⭐ The failure mode this is built for

Not a crash — a **silently degraded input** producing a confident, balanced, *wrong* close. In July 2026 a dead QuickBooks connection made the receipts lookup return "0 received" for all 56 items behind a bare `catch {}`, which alone booked a **$67,131** phantom gain. Nothing errored; the JE still balanced.

So input health is graded as **hard blockers, never warnings**, and an input that cannot be *verified* is treated as failed rather than as a legitimate zero.

## Blocking codes

| Code | Fires when | Real precedent |
|---|---|---|
| `empty_opening_book` | no prior-month `month_end_post` rows | a missing basis read as zero → 1,097,674-unit adjustment |
| `missing_processor_summaries` | any of the 3 processors absent for the month | JE omits that block and cannot balance |
| `receipts_lookup_unavailable` | the QB Bill/Purchase query did not succeed | the $67,131 phantom gain |
| `no_physical_snapshot` | no FBA or 3PL snapshot on/before period end | — |
| `stale_physical_snapshot` | a snapshot exists but isn't period end | physical measured on the wrong day |
| `je_out_of_balance` | \|debits − credits\| > $0.01 | July was out by $48.27 from one dropped order line |
| `adjustment_implausible` | adjustment > 3× the recent max | July's first run: $85,864 vs a $2–3K run-rate |

**All blockers are reported at once**, not just the first — an operator fixing one input per run is how July took six passes.

`receipts_lookup_ok = true` with zero items is a **warning** ("genuinely nothing received"), not a blocker. That distinction is the whole point.

## Gotchas

- **Round money before comparing.** `Math.abs(100 − 99.99)` is `0.010000000000005` in floating point, so an exactly-at-tolerance JE fails a naive `<= 0.01`. The balance check rounds to cents first. Caught by `close-guard.test.ts`.
- `assertPostable` checks **run-once first**, then dry-run-proven — the cheaper and more dangerous condition leads.
- The `(workspace_id, closing_month)` UNIQUE on [[../tables/qb_month_end_closings]] is the schema-level backstop; `assertPostable` is the polite refusal. Never rely on only one.
- `recordDryRun` is **append-only** — never update a prior verdict. Keeping every attempt makes "what did we know when we posted?" answerable and makes a regression between two runs visible.
- The plausibility band is a **tripwire, not a proof**. It is skipped entirely when there is no history to compare against.
- The guard grades what it is *given*; it cannot detect an input that is present but wrong. Column-selection correctness lives in [[qb-close-month-end]].

## Tests

`src/lib/qb-close/close-guard.test.ts` — 12 cases, each a real July 2026 failure. Run: `npx tsx --test src/lib/qb-close/close-guard.test.ts`.

## Related

[[qb-close-month-end]] · [[../tables/qb_close_dry_runs]] · [[../tables/qb_month_end_closings]] · [[../lifecycles/shoptics-migration]]
