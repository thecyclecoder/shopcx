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
- `parsePnlRollups(report)` → `PnlRollups` — extract the top-level section totals (keyed by each section's `group`) **plus** `management_fees` (via `findLineAmount`) and the computed `adjusted_net_income = net_income + management_fees`.
- `findLineAmount(report, matcher)` — recursively find a leaf account line's amount by name regex (used for the Management Fees line inside `OtherExpenses`).
- `pnlCurrency(report)` — the report's currency (default `USD`).
- `lastClosedMonths(n, asOf?)` — the last `n` **fully-elapsed** months oldest→newest (excludes the in-progress month — mid-month QBO P&L is distorted by month-end entries). Each is `{ periodMonth, start, end }`.
- `snapshotPnlMonth(workspaceId, month, admin?)` — pull one closed month + upsert its [[../tables/qb_pnl_snapshots]] row (on `(workspace_id, period_month)`). Returns the parsed rollups.
- `backfillPnlSnapshots(workspaceId, n=24, admin?)` — snapshot the last `n` closed months.

## Callers

- `scripts/_backfill-pnl-snapshots.ts` — seeds the last 24 closed months for Superfoods (the Step-1 deliverable).
- `scripts/_copy-qbo-connection-from-shoptics.ts` — one-time connection seed (reads shoptics' DB, writes the encrypted [[../tables/quickbooks_connections]] row).
- `src/app/api/qbo/{connect,callback,disconnect,status}/route.ts` — the OAuth connect card flow.
- `src/app/api/director/cfo/pnl/route.ts` — feeds the **CFO → Financials** visual ([[../functions/cfo]]): 4 small-multiple charts (Revenue · Net Profit · Mgmt Fees · NP + Addbacks) on Grace's director page (`dashboard/agents/cfo?s=financials`, `src/components/agents/cfo-financials.tsx`), each with its own scale, a period-total headline, range filter (24mo / this year / last year / quarter), and hover/click-pin per-month readout.
- The recurring monthly snapshot (append the newest closed month) + a **Fixed OpEx** chart (Total Expenses − `60510 Digital Advertising`, since paid ads are variable) + the CEO north-star scoreboard are the next CFO specs.

## Gotchas

- **Closed months only** (`lastClosedMonths` starts from last month) — never snapshot the current month.
- **Refresh-token rotation** persisted in `getQboAccessToken` only — see [[../tables/quickbooks_connections]] for the shoptics shared-token caveat.
- **Two profit lines.** `net_income` is booked-as-is (fiscal-year ≤$0 target); `adjusted_net_income` adds back the management fee. The management-fee line is name-matched — a rename breaks it (surfaces as `management_fees` null).
- **No retry/backoff yet** (parity with shoptics). QBO throttle ~500 req/min/realm; the 24-call backfill is well under. Add 429 backoff + a 401-force-refresh-retry if we grow heavier callers.

## Related

[[../tables/qb_pnl_snapshots]] · [[../tables/quickbooks_connections]] · [[crypto]] · [[../integrations/quickbooks-online]] · [[../functions/cfo]] · [[../functions/logistics]] · [[../project-management]]
