# `src/lib/meta/budget-alerts.ts`

The founder's **spend tripwire** (CEO 2026-07-10). Texts the founder whenever an ad account's **total live daily budget climbs** — a new test running, a raised budget, or a runaway ("Superfood Tabs daily budget is now $3,000" = something went wrong) — so he can catch it fast while traveling. Pure notification; no autonomy.

## How
- `accountActiveDailyBudgetCents(token, bareMetaAccountId)` — **Meta ground truth** (not our synced tables, which lag): Σ `daily_budget` over ACTIVE adsets (ABO) + ACTIVE CBO campaigns via the Graph API. Meta returns `daily_budget` as a cents string.
- `checkAndAlertAccountBudget(admin, account)` — compares the live total against `meta_ad_accounts.last_notified_daily_budget_cents`. On an **increase**, sends ONE SMS via [[twilio]] `sendSMS` to [[god-mode]] `resolveFounderPhone` (`workspaces.god_mode_sms_number` → env `GOD_MODE_FOUNDER_PHONE`), body `"{account} daily budget is now $X/day (was $Y). If that looks wrong, pause it."`, then updates the baseline. The **first-ever** check just seeds the baseline (prev null → no SMS).

## Driver
[[../inngest/budget-watch]] `budgetWatchCron` — `*/10 * * * *`, iterates every active [[../tables/meta_ad_accounts]] and calls the checker. Control-Tower heartbeat `budget-watch-cron` (owner growth). Because it reads Meta directly, it catches EVERY source of an increase — Bianca scaling a winner, a new test adset, a manual change — within ~10 min, independent of our sync lag.

## Why it matters
This is the founder's eyes-on-spend while the growth agents (Bianca, Dahlia) run autonomously — the human tripwire layered on top of the in-system rails ($500/day cohort ceiling + the media-buyer auto-disarm). A budget number that jumps out of range is the fastest anomaly signal there is.

## Related
[[../inngest/budget-watch]] · [[twilio]] · [[god-mode]] (`resolveFounderPhone`) · [[../tables/meta_ad_accounts]] · [[media-buyer-agent]] (the main autonomous budget-mover) · [[max-watch]] (the hourly supervisor that also checks spend).
