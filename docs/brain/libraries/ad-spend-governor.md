# libraries/ad-spend-governor

Ad-spend governor — the **SUPERVISOR** on the Growth director's ad-DOLLAR proxy. Reads each effective [[../tables/ad_spend_budgets]] row vs the [[../tables/daily_meta_ad_spend]] rolling-window sum and **ESCALATES** on a trend over the ceiling via [[platform-director]] `escalateDiagnosisToCeo` (`escalationKind='ad_spend_ceiling'`) + a growth-owned [[../tables/director_activity]] row (`director_function='growth'`, `action_kind='escalated_ad_spend_ceiling'`). **NEVER pauses or throttles a campaign** — escalation only ([[../operational-rules]] § North star). Authored by [[../specs/growth-ad-spend-rail]] (M3 — Spend rails of [[../goals/growth]]).

**File:** `src/lib/ad-spend-governor.ts`

**Distinct from two neighbouring concepts** — keep them straight:

- [[fleet-spend-governor]] supervises the **Max-lane TOKENS** ([[../tables/fleet_budgets]]) for the box agent fleet — not ad dollars.
- [[../tables/iteration_policies]] `per_account_daily_budget_delta_ceiling_cents` caps a **single PASS** of motion (how much the iteration loop may move an account's daily budget in one optimizer step) — not the rolling-window total this governor checks.

## The trend rule (why a single-day spike doesn't page the CEO)

The escalation gate is a **TREND**, not a daily threshold: the rolling `window_days` sum **AS OF TODAY** AND **AS OF YESTERDAY** must both exceed the ceiling. A one-day spike that pulls today's window over but yesterday's was still under is **observed but not escalated** — the governor only pings the CEO when ad spend has clearly trended above the rail for two consecutive same-length windows. This avoids paging on a single noisy reporting day while still surfacing sustained overrun within ~24h.

## Exports

### `AdSpendPlatform` — type

`"meta" | "google" | "amazon"` — the ad-channel envelope on a budget row. Only `'meta'` is wired today (the spend table is Meta-only); a `'google'`/`'amazon'` budget rolls up to 0 and never breaches until the per-platform spend tables land.

### `AdSpendBudget` — interface

TS shape of an [[../tables/ad_spend_budgets]] row (`snake → camel`; `bigint` `usd_ceiling_cents` normalized to `number`).

### `listAdSpendBudgets` — function

```ts
async function listAdSpendBudgets(admin: Admin, workspaceId: string): Promise<AdSpendBudget[]>
```

Every [[../tables/ad_spend_budgets]] row owned by the workspace (the table is workspace-scoped — no global default).

### `getEffectiveAdSpendBudget` — function

```ts
async function getEffectiveAdSpendBudget(
  admin: Admin,
  workspaceId: string,
  args: { platform: AdSpendPlatform; metaAdAccountId?: string | null },
): Promise<AdSpendBudget | null>
```

The MORE-SPECIFIC row wins: a per-account row (`meta_ad_account_id` set) beats the platform-wide row (`meta_ad_account_id IS NULL`) for the same `workspace+platform`. Returns `null` when neither exists.

### `rollupAdSpendActual` — function

```ts
async function rollupAdSpendActual(
  admin: Admin,
  args: { workspaceId: string; platform: AdSpendPlatform; metaAdAccountId?: string | null; windowDays: number; asOfDate?: string },
): Promise<AdSpendRollup>
```

Sums [[../tables/daily_meta_ad_spend]] `spend_cents` over the rolling `[sinceDate, toDate]` window for one `(workspace_id, meta_ad_account_id)` — `metaAdAccountId=null` sums the whole workspace's Meta spend. `asOfDate` defaults to today (UTC); the governor calls it with today AND yesterday to detect the 2-day trend. Returns `{ actualCents, toDate, sinceDate, windowDays }`. Returns `0` for `platform='google'`/`'amazon'` (no per-platform spend table yet).

### `runAdSpendGovernorPass` — function

```ts
async function runAdSpendGovernorPass(admin: Admin, opts?: { workspaceId?: string }): Promise<AdSpendGovernorPassResult>
```

The cadence pass. Reads every [[../tables/ad_spend_budgets]] row (one workspace if `opts.workspaceId` is supplied, else all workspaces — the Phase-3 cron fans out per workspace). For each budget it rolls up the actual spend over TWO consecutive same-length windows (today + yesterday), and on a TREND over (`currentOver && priorOver`) emits ONE CEO Approval Request via [[platform-director]] `escalateDiagnosisToCeo` + ONE growth [[../tables/director_activity]] row (`action_kind='escalated_ad_spend_ceiling'`, `metadata={platform, meta_ad_account_id, window_days, actual_cents, ceiling_cents, dedupe_key}`). NEVER pauses, throttles, or kills a campaign.

`AdSpendGovernorPassResult`: `{ observed, escalations, observations: AdSpendBudgetObservation[] }`. `observed` = budgets evaluated this pass; `escalations` = newly-emitted (deduped on the prior open notification); `observations[]` carries each `{ budget, current, prior, currentOver, priorOver, trendOver }` (used by the cron heartbeat + tests + the Phase-3 director brief).

### `AdSpendBudgetObservation` — interface

Per-budget snapshot exposed by `runAdSpendGovernorPass` and reused by the Phase-3 director brief: the budget + the two rolling-window rollups + the `currentOver`/`priorOver`/`trendOver` booleans.

### `AdSpendRollup` — interface

`{ actualCents, toDate, sinceDate, windowDays }` — one rolling-window sum of actual ad spend ending on `toDate` (UTC).

## Callers

- **Phase 3 (planned):** [[../inngest/growth-ad-spend-governor-cron]] daily cron — fans out one event per workspace with ≥1 [[../tables/ad_spend_budgets]] row; the handler calls `runAdSpendGovernorPass(admin, { workspaceId })`.
- **Phase 3 (planned):** [[../libraries/growth-director]] brief loader — `loadEffectiveAdSpendBudgets` exposes the workspace's active ceilings + current rolling-window actuals to `buildGrowthDirectorBrief`, so every Growth director investigation can see the leash.

## Gotchas

- **Trend, not threshold.** A single-day spike that pulls today's window over but leaves yesterday's under is **observed**, not escalated — the gate is `currentOver && priorOver`. This is intentional: don't page the CEO on one noisy reporting day.
- **NEVER pauses or throttles a campaign.** The governor only ESCALATES. Within-ceiling reallocation stays autonomous (the Growth director's `reallocate_within_ceiling` leash category); raising the ceiling is the CEO's call ([[../operational-rules]] § North star).
- **Per-account row beats platform-wide.** A workspace can hold both a platform-wide budget (`meta_ad_account_id IS NULL`) and a per-account budget (`meta_ad_account_id` set) for the same platform — `getEffectiveAdSpendBudget` returns the more-specific one. The governor pass evaluates every row independently (each has its own dedupe key + escalation lane).
- **Loop-guarded by the CEO inbox.** [[platform-director]] `escalateDiagnosisToCeo` dedupes on an existing [[../tables/dashboard_notifications]] row keyed `metadata.dedupe_key = ad_spend_ceiling:<workspace>:<platform>:<account-or-all>`. One OPEN ceiling notification per (workspace, platform, account) at a time; once the CEO dismisses it, a still-breaching budget re-surfaces on the next sweep — and writes a fresh growth `escalated_ad_spend_ceiling` ledger row at that point.
- **Two `director_activity` rows per breach, on purpose.** `escalateDiagnosisToCeo` writes its OWN platform-owned `escalated` row (the standard "Ada pinged the CEO" audit). The governor then writes a **growth-owned** `escalated_ad_spend_ceiling` row carrying the per-breach metadata the spec calls for (the Growth audit trail). They record different facts at different altitudes — that's intentional, not double-counting.
- **`daily_meta_ad_spend` is Meta-only.** `rollupAdSpendActual` returns `0` for `platform='google'`/`'amazon'`, so a budget on either platform will never breach until a per-platform spend table lands. A `meta` budget on a workspace with no Meta ad accounts will also roll up to 0.
- **`bigint` arrives as a string from PostgREST.** `toBudget` normalizes `usd_ceiling_cents` to `number` so callers don't have to.
- **UTC days.** The trend windows are sliced on UTC calendar days (`asOfDate.slice(0,10)`) — a workspace whose local day differs may see a 24h-lagged trend on the boundary, which is fine for a daily-cadence supervisor.

## Related

[[../tables/ad_spend_budgets]] · [[../tables/daily_meta_ad_spend]] · [[../tables/dashboard_notifications]] · [[../tables/director_activity]] · [[platform-director]] · [[fleet-spend-governor]] · [[growth-director]] · [[../specs/growth-ad-spend-rail]] · [[../functions/growth]] · [[../operational-rules]] (§ North star — supervisable autonomy)
