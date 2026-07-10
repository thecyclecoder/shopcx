# libraries/quickbooks

The QuickBooks Online client + P&L snapshotter — the CFO's financial-data tool. Owner: [[../functions/cfo]] (Grace). First slice of the shoptics→shopcx migration (shoptics = the retiring logistics/finance engine; its QBO capability moves here).

**File:** `src/lib/quickbooks.ts`

## Why

The CEO north star (**Grow Profits** primary, **Grow Revenue** the floor) can only be measured against the real books. This module pulls the monthly ProfitAndLoss from QBO into [[../tables/qb_pnl_snapshots]] — `total_income` = revenue, `net_income` = actual booked profit (the fiscal-year ≤$0 US-tax target), `adjusted_net_income` = profit with the management-fee addback (true economic profit). Multi-tenant, per-workspace encrypted connection ([[../tables/quickbooks_connections]] + [[crypto]]), all writes via `createAdminClient()`.

It replaces shoptics' **six** inline token-refresh copies with **one** token manager, and adds what shoptics never had: the `reports/ProfitAndLoss` pull. Full API/auth reference: [[../integrations/quickbooks-online]].

## Exports

### OAuth connect flow (Integrations → QuickBooks card)
So shopcx gets its OWN refresh token via its own authorization grant — independent from shoptics' token (each grant is a separate lineage, so the two apps don't fight over rotation). App creds come from env (`QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET` / `QUICKBOOKS_ENVIRONMENT`).
- `qboAppCreds()` — the app-level Intuit OAuth creds from env. Throws if unconfigured (the card shows a "not configured" notice).
- `buildAuthorizeUrl(state, redirectUri)` — the Intuit consent URL (`appcenter.intuit.com/connect/oauth2`, scope `com.intuit.quickbooks.accounting`).
- `exchangeCodeForTokens(code, redirectUri)` — trade the callback `code` for `{ refresh_token, access_token, expires_in }` (Basic-auth = base64(id:secret)).
- `saveOAuthConnection(workspaceId, { realmId, refreshToken }, admin?)` — encrypt refresh token + app creds and upsert the [[../tables/quickbooks_connections]] row (on `workspace_id`); clears the access-token cache.
- `getQboConnectionStatus(workspaceId, admin?)` — non-secret status `{ connected, realmId, environment, connectedAt }` for the card.
- `disconnectQbo(workspaceId, admin?)` — revoke the refresh token at Intuit (best-effort) + delete the row.

Routes: `GET /api/qbo/connect` (redirect to Intuit, CSRF nonce cookie), `GET /api/qbo/callback` (validate nonce + owner/admin, exchange, save, bounce to the settings page with `?qbo=<status>`), `POST /api/qbo/disconnect`, `GET /api/qbo/status`. UI: `dashboard/settings/integrations/quickbooks` (Connect / status / Disconnect) + the card on the integrations page. **One-time setup:** register `${NEXT_PUBLIC_SITE_URL}/api/qbo/callback` as a Redirect URI in the Intuit developer app.

### Connection + auth
- `getQboConnection(workspaceId, admin?)` — read + decrypt the workspace's [[../tables/quickbooks_connections]] row → `{ realmId, environment, refreshToken, clientId, clientSecret }`. Throws if not connected.
- `getQboAccessToken(workspaceId, admin?)` — refresh via the stored token, cache the access token per-workspace (60s margin), and **re-encrypt + persist the rotated refresh token** every time. Returns `{ token, realmId }`.
- `qboFetch(workspaceId, path, { method?, query?, body?, admin? })` — thin authenticated request; injects `/v3/company/{realmId}/{path}?minorversion=65` + Bearer + JSON headers.

### P&L
- `fetchProfitAndLoss(workspaceId, startDate, endDate, admin?)` — pull the accrual ProfitAndLoss report for a date range.
- `parsePnlRollups(report)` → `PnlRollups` — extract the nine top-level section totals (keyed by each section's `group`) **plus** the name-matched breakout lines: `management_fees` and `adjusted_net_income = net_income + management_fees`; the **variable-cost** lines `digital_advertising` (bridged, see below), `transaction_fees`, and the derived `fixed_opex = total_expenses − OpEx-ad-line − transaction_fees`; and the **contributor** lines `refunds` / `chargebacks` / `discounts_coupons` (stored as positive magnitudes) + `inventory_adjustments` (signed).
- `findLineAmount` / `findAmountByName(report, matcher)` — recursively find one account's amount by name regex; handles both a leaf `ColData` line **and** a group node (Header + `Summary` total). Used for the management-fee, transaction-fees, and contributor lines.
- `sumAmountsByName(report, matcher)` — sum **all** accounts whose name matches (does not descend into a matched node, to avoid double-counting a group + its children). Powers the `digital_advertising` **bridge**: pre-2025 ad spend lived in COGS as per-channel accounts (`Ads - Facebook/Amazon/Google/TikTok`), 2025+ consolidated into the OpEx line "60510 Digital Advertising" — `AD_SPEND_MATCHER` spans both so the series is continuous. `fixed_opex` deliberately uses only `OPEX_AD_LINE_MATCHER` (post-2025 line) — never the bridge — since pre-2025 ads were never in `total_expenses`.
- **Matchers** (module consts): `MANAGEMENT_FEES_MATCHER`, `AD_SPEND_MATCHER` (bridge) / `OPEX_AD_LINE_MATCHER` (fixed-opex net-out), `TRANSACTION_FEES_MATCHER`, `REFUNDS_MATCHER`, `CHARGEBACKS_MATCHER`, `DISCOUNTS_MATCHER`, `INVENTORY_ADJ_MATCHER`. Each is name-based → survives re-nesting, breaks on an account rename.
- `pnlCurrency(report)` — the report's currency (default `USD`).
- `lastClosedMonths(n, asOf?)` — the last `n` **fully-elapsed** months oldest→newest (excludes the in-progress month — mid-month QBO P&L is distorted by month-end entries). Each is `{ periodMonth, start, end }`.
- `snapshotPnlMonth(workspaceId, month, admin?)` — pull one closed month + upsert its [[../tables/qb_pnl_snapshots]] row (on `(workspace_id, period_month)`). Returns the parsed rollups.
- `backfillPnlSnapshots(workspaceId, n=24, admin?)` — snapshot the last `n` closed months.

## Callers

- `scripts/_backfill-pnl-snapshots.ts` — seeds the last 24 closed months for Superfoods (the Step-1 deliverable).
- `scripts/_backfill-variable-costs-from-raw.ts` — re-parses the stored `raw` for every snapshot and updates only the 7 breakout columns (digital-ads / txn-fees / fixed-opex / refunds / chargebacks / discounts / inventory-adj). No QBO round-trip; safe to re-run after a matcher change.
- `scripts/_copy-qbo-connection-from-shoptics.ts` — one-time connection seed (reads shoptics' DB, writes the encrypted [[../tables/quickbooks_connections]] row).
- `src/app/api/qbo/{connect,callback,disconnect,status}/route.ts` — the OAuth connect card flow.
- `src/app/api/director/cfo/pnl/route.ts` — feeds the **CFO → Financials** visual ([[../functions/cfo]]): **11 small-multiple charts in 3 sections** on Grace's director page (`dashboard/agents/cfo?s=financials`, `src/components/agents/cfo-financials.tsx`) — **Top Line Stats** (Revenue · Net Profit · NP + Addbacks) · **Drivers** (Fixed OpEx · Digital Ads · Transaction Fees · Mgmt Fees) · **Contributors** (Refunds · Chargebacks · Discounts & Coupons · Inventory Adjustments). Each chart has its own scale, a period-total headline, a range filter (24mo / this year / last year / quarter), and synced hover/click-pin per-month readout.
- The recurring monthly snapshot (append the newest closed month) + the CEO north-star scoreboard are the next CFO specs.

## Gotchas

- **Closed months only** (`lastClosedMonths` starts from last month) — never snapshot the current month.
- **Refresh-token rotation** persisted in `getQboAccessToken` only — see [[../tables/quickbooks_connections]] for the shoptics shared-token caveat.
- **Two profit lines.** `net_income` is booked-as-is (fiscal-year ≤$0 target); `adjusted_net_income` adds back the management fee. The management-fee line is name-matched — a rename breaks it (surfaces as `management_fees` null).
- **Variable costs live in OpEx but are pulled out.** Digital ads + platform transaction fees are booked inside `total_expenses` yet scale with sales/ad-buy, so they're extracted and `fixed_opex` is the remainder — the honest cost-to-operate line. Amazon FBA fees are also variable but sit in **COGS**, so they're already outside `fixed_opex` (don't subtract them).
- **Ad-account bridge asymmetry.** `digital_advertising` sums both the pre-2025 COGS ad accounts and the post-2025 OpEx line (`sumAmountsByName` + `AD_SPEND_MATCHER`) for a continuous series; `fixed_opex` nets out **only** the post-2025 OpEx line. Never bridge `fixed_opex` — the pre-2025 accounts were in COGS, not expenses, so subtracting them double-counts.
- **No retry/backoff yet** (parity with shoptics). QBO throttle ~500 req/min/realm; the 24-call backfill is well under. Add 429 backoff + a 401-force-refresh-retry if we grow heavier callers.

## Related

[[../tables/qb_pnl_snapshots]] · [[../tables/quickbooks_connections]] · [[crypto]] · [[../integrations/quickbooks-online]] · [[../functions/cfo]] · [[../functions/logistics]] · [[../project-management]]
