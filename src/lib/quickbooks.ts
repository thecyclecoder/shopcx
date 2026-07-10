/**
 * QuickBooks Online (QBO) client + P&L snapshotting — the CFO's financial-data tool.
 *
 * First slice of the shoptics→shopcx migration (shoptics is the retiring logistics/finance engine;
 * its QBO capability moves here under the CFO seat — docs/brain/functions/cfo.md). Multi-tenant,
 * per-workspace AES-256-GCM encrypted connection (src/lib/crypto.ts), all writes via createAdminClient().
 *
 * ONE token manager (unlike shoptics' 6 inline refresh copies): getQboAccessToken refreshes on demand,
 * persists the rotated refresh token every time, and caches the access token per workspace.
 *
 * The headline use: snapshot the monthly ProfitAndLoss for CLOSED months only into qb_pnl_snapshots
 * (mid-month QBO P&L is distorted by month-end entries). Revenue = total_income, Profit = net_income —
 * the two CEO north-star lines (Grow Profits primary, Grow Revenue the floor).
 *
 * See docs/brain/integrations/quickbooks-online.md (the porting reference) + docs/brain/libraries/quickbooks.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { encrypt, decrypt } from "@/lib/crypto";

const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

type Admin = SupabaseClient;

export interface QboConnection {
  workspaceId: string;
  realmId: string;
  environment: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}

/** Base QBO API host for a connection's environment. Token/authorize/revoke hosts are shared across both. */
function apiBase(environment: string): string {
  return environment === "production"
    ? "https://quickbooks.api.intuit.com"
    : "https://sandbox-quickbooks.api.intuit.com";
}

// ── OAuth 2.0 connect flow (Integrations → QuickBooks "Connect" card) ─────────────────────────────
// So shopcx gets its OWN refresh token via its own authorization grant — independent from shoptics'
// token (each grant is a separate token lineage, so the two apps stop fighting over rotation).

export const QBO_AUTHORIZE_URL = "https://appcenter.intuit.com/connect/oauth2";
export const QBO_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";
export const QBO_SCOPE = "com.intuit.quickbooks.accounting";

/** App-level Intuit OAuth creds from env (shared across all workspaces — one Intuit app). */
export function qboAppCreds(): { clientId: string; clientSecret: string; environment: string } {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("QuickBooks app not configured (QUICKBOOKS_CLIENT_ID / QUICKBOOKS_CLIENT_SECRET)");
  return { clientId, clientSecret, environment: process.env.QUICKBOOKS_ENVIRONMENT || "production" };
}

/** The Intuit consent URL to redirect the user to. `state` should encode the workspace + a CSRF nonce. */
export function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const { clientId } = qboAppCreds();
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    scope: QBO_SCOPE,
    redirect_uri: redirectUri,
    state,
  });
  return `${QBO_AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchange an authorization code for tokens (Basic-auth = base64(client_id:client_secret)). */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<{ refresh_token: string; access_token: string; expires_in: number }> {
  const { clientId, clientSecret } = qboAppCreds();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!res.ok) throw new Error(`QBO code exchange failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/**
 * Persist a freshly-authorized connection: encrypt the refresh token + the app creds (so the token
 * manager stays row-sourced) and upsert on workspace_id. Clears the in-memory access-token cache so
 * the next call re-derives against the new token.
 */
export async function saveOAuthConnection(
  workspaceId: string,
  opts: { realmId: string; refreshToken: string },
  admin: Admin = createAdminClient(),
): Promise<void> {
  const { clientId, clientSecret, environment } = qboAppCreds();
  const nowIso = new Date().toISOString();
  const { error } = await admin.from("quickbooks_connections").upsert(
    {
      workspace_id: workspaceId,
      realm_id: opts.realmId,
      environment,
      refresh_token_encrypted: encrypt(opts.refreshToken),
      client_id_encrypted: encrypt(clientId),
      client_secret_encrypted: encrypt(clientSecret),
      connected_at: nowIso,
      token_rotated_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "workspace_id" },
  );
  if (error) throw new Error(`save QBO connection: ${error.message}`);
  tokenCache.delete(workspaceId);
}

/** Non-secret connection status for the Integrations UI. */
export async function getQboConnectionStatus(
  workspaceId: string,
  admin: Admin = createAdminClient(),
): Promise<{ connected: boolean; realmId: string | null; environment: string | null; connectedAt: string | null }> {
  const { data } = await admin
    .from("quickbooks_connections")
    .select("realm_id, environment, connected_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return {
    connected: !!data,
    realmId: data?.realm_id ?? null,
    environment: data?.environment ?? null,
    connectedAt: data?.connected_at ?? null,
  };
}

/** Revoke the refresh token at Intuit (best-effort) and delete the connection row. */
export async function disconnectQbo(workspaceId: string, admin: Admin = createAdminClient()): Promise<void> {
  try {
    const conn = await getQboConnection(workspaceId, admin);
    const basic = Buffer.from(`${conn.clientId}:${conn.clientSecret}`).toString("base64");
    await fetch(QBO_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Basic ${basic}` },
      body: JSON.stringify({ token: conn.refreshToken }),
    });
  } catch {
    // best-effort revoke — proceed to delete the row regardless
  }
  await admin.from("quickbooks_connections").delete().eq("workspace_id", workspaceId);
  tokenCache.delete(workspaceId);
}

/** Read + decrypt the workspace's QBO connection. Throws if not connected. */
export async function getQboConnection(workspaceId: string, admin: Admin = createAdminClient()): Promise<QboConnection> {
  const { data, error } = await admin
    .from("quickbooks_connections")
    .select("realm_id, environment, refresh_token_encrypted, client_id_encrypted, client_secret_encrypted")
    .eq("workspace_id", workspaceId)
    .single();
  if (error || !data) throw new Error(`No QuickBooks connection for workspace ${workspaceId}: ${error?.message ?? "not found"}`);
  return {
    workspaceId,
    realmId: data.realm_id,
    environment: data.environment,
    refreshToken: decrypt(data.refresh_token_encrypted),
    clientId: decrypt(data.client_id_encrypted),
    clientSecret: decrypt(data.client_secret_encrypted),
  };
}

// per-workspace access-token cache (module memory; a 60s safety margin like shoptics)
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * A fresh access token + realmId for the workspace. Refreshes via the stored refresh token, then
 * RE-ENCRYPTS and persists the rotated refresh token (Intuit rotates it on every refresh — dropping
 * it breaks the next call with invalid_grant). Access token cached in memory.
 */
export async function getQboAccessToken(
  workspaceId: string,
  admin: Admin = createAdminClient(),
): Promise<{ token: string; realmId: string }> {
  const conn = await getQboConnection(workspaceId, admin);
  const cached = tokenCache.get(workspaceId);
  if (cached && Date.now() < cached.expiresAt - 60_000) return { token: cached.token, realmId: conn.realmId };

  const basic = Buffer.from(`${conn.clientId}:${conn.clientSecret}`).toString("base64");
  const res = await fetch(QB_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: conn.refreshToken }),
  });
  if (!res.ok) throw new Error(`QBO token refresh failed (${res.status}): ${await res.text()}`);
  const data = await res.json();

  tokenCache.set(workspaceId, { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 });
  if (data.refresh_token && data.refresh_token !== conn.refreshToken) {
    await admin
      .from("quickbooks_connections")
      .update({ refresh_token_encrypted: encrypt(data.refresh_token), token_rotated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("workspace_id", workspaceId);
  }
  return { token: data.access_token, realmId: conn.realmId };
}

/** Thin authenticated QBO request. `path` is appended after /v3/company/{realmId}/. minorversion pinned at 65. */
export async function qboFetch(
  workspaceId: string,
  path: string,
  opts: { method?: string; query?: Record<string, string>; body?: unknown; admin?: Admin } = {},
): Promise<any> {
  const admin = opts.admin ?? createAdminClient();
  const conn = await getQboConnection(workspaceId, admin);
  const { token } = await getQboAccessToken(workspaceId, admin);
  const qs = new URLSearchParams({ minorversion: "65", ...(opts.query ?? {}) }).toString();
  const url = `${apiBase(conn.environment)}/v3/company/${conn.realmId}/${path}?${qs}`;
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`QBO ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/** Pull the ProfitAndLoss report for a date range (accrual). */
export async function fetchProfitAndLoss(
  workspaceId: string,
  startDate: string,
  endDate: string,
  admin: Admin = createAdminClient(),
): Promise<any> {
  return qboFetch(workspaceId, "reports/ProfitAndLoss", {
    query: { start_date: startDate, end_date: endDate, accounting_method: "Accrual" },
    admin,
  });
}

/** The top-level section rollups the CEO scoreboard reads, plus the management-fee addback. */
export interface PnlRollups {
  total_income: number | null;
  total_cogs: number | null;
  gross_profit: number | null;
  total_expenses: number | null;
  net_operating_income: number | null;
  total_other_income: number | null;
  total_other_expenses: number | null;
  net_other_income: number | null;
  net_income: number | null;
  /**
   * "82000 Management Fees" line amount (positive expense). This is an intercompany transfer-pricing
   * charge (PR entity → TX Superfoods entity) — NOT a real group cost. See adjusted_net_income.
   */
  management_fees: number | null;
  /**
   * The PRIMARY north-star profit line: net_income + management_fees. Adds back the intercompany
   * management fee, which net_income has already expensed, to reflect true group economic profit.
   */
  adjusted_net_income: number | null;
}

const GROUP_TO_FIELD: Record<string, keyof PnlRollups> = {
  Income: "total_income",
  COGS: "total_cogs",
  GrossProfit: "gross_profit",
  Expenses: "total_expenses",
  NetOperatingIncome: "net_operating_income",
  OtherIncome: "total_other_income",
  OtherExpenses: "total_other_expenses",
  NetOtherIncome: "net_other_income",
  NetIncome: "net_income",
};

function toNum(v: unknown): number | null {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Recursively find a leaf account line's amount (last-column value) by matching its display name.
 * Used to pull the "Management Fees" line out of the OtherExpenses subtree regardless of nesting.
 */
export function findLineAmount(report: any, matcher: RegExp): number | null {
  const walk = (rows: any[]): number | null => {
    for (const r of rows ?? []) {
      if (Array.isArray(r.ColData)) {
        const name = r.ColData[0]?.value ?? "";
        if (matcher.test(name)) return toNum(r.ColData[r.ColData.length - 1]?.value);
      }
      const nested = r.Rows?.Row;
      if (nested) { const hit = walk(nested); if (hit !== null) return hit; }
    }
    return null;
  };
  return walk(report?.Rows?.Row ?? []);
}

/** The "82000 Management Fees" intercompany line (PR→TX transfer pricing). */
const MANAGEMENT_FEES_MATCHER = /management fee/i;

/**
 * Extract the top-level section rollups from a single-period ProfitAndLoss report. Each top-level
 * section Row carries a `group` (Income/COGS/GrossProfit/…) and a `Summary.ColData` whose LAST cell
 * is the period total. Robust to missing sections (a section with no activity is simply absent).
 *
 * Also pulls the Management Fees line and computes `adjusted_net_income` = net_income + management_fees
 * (the transfer-pricing addback — the true economic profit north-star line). `net_income` is left
 * exactly as booked (the number the fiscal-year ≤$0 US-tax target watches).
 */
export function parsePnlRollups(report: any): PnlRollups {
  const out: PnlRollups = {
    total_income: null, total_cogs: null, gross_profit: null, total_expenses: null,
    net_operating_income: null, total_other_income: null, total_other_expenses: null,
    net_other_income: null, net_income: null, management_fees: null, adjusted_net_income: null,
  };
  for (const row of report?.Rows?.Row ?? []) {
    const field = GROUP_TO_FIELD[row.group];
    if (!field) continue;
    const cells = row.Summary?.ColData ?? [];
    out[field] = toNum(cells[cells.length - 1]?.value);
  }
  out.management_fees = findLineAmount(report, MANAGEMENT_FEES_MATCHER);
  if (out.net_income !== null) {
    out.adjusted_net_income = out.net_income + (out.management_fees ?? 0);
  }
  return out;
}

/** Currency reported by the P&L (defaults USD). */
export function pnlCurrency(report: any): string {
  return report?.Header?.Currency ?? "USD";
}

/** First-of-month ISO date (YYYY-MM-01) for a Date. */
function firstOfMonth(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Last day of a month given its first-of-month Date. */
function lastOfMonth(year: number, month0: number): string {
  const last = new Date(Date.UTC(year, month0 + 1, 0));
  return `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, "0")}-${String(last.getUTCDate()).padStart(2, "0")}`;
}

/**
 * The last `n` CLOSED (fully-elapsed) months as of `asOf`, oldest→newest. The current in-progress
 * month is excluded (its QBO P&L is distorted by pending month-end entries). Returns {periodMonth,
 * start, end} triples ready for fetchProfitAndLoss.
 */
export function lastClosedMonths(n: number, asOf: Date = new Date()): { periodMonth: string; start: string; end: string }[] {
  const out: { periodMonth: string; start: string; end: string }[] = [];
  // start from the month BEFORE asOf's month (last fully-closed month)
  let y = asOf.getUTCFullYear();
  let m0 = asOf.getUTCMonth() - 1; // previous month
  for (let i = 0; i < n; i++) {
    if (m0 < 0) { m0 += 12; y -= 1; }
    const start = `${y}-${String(m0 + 1).padStart(2, "0")}-01`;
    out.push({ periodMonth: start, start, end: lastOfMonth(y, m0) });
    m0 -= 1;
  }
  return out.reverse();
}

/** Pull one closed month's P&L and upsert its snapshot row. Returns the parsed rollups. */
export async function snapshotPnlMonth(
  workspaceId: string,
  month: { periodMonth: string; start: string; end: string },
  admin: Admin = createAdminClient(),
): Promise<PnlRollups & { period_month: string }> {
  const conn = await getQboConnection(workspaceId, admin);
  const report = await fetchProfitAndLoss(workspaceId, month.start, month.end, admin);
  const rollups = parsePnlRollups(report);
  const nowIso = new Date().toISOString();
  const { error } = await admin.from("qb_pnl_snapshots").upsert(
    {
      workspace_id: workspaceId,
      period_month: month.periodMonth,
      currency: pnlCurrency(report),
      accounting_method: "Accrual",
      realm_id: conn.realmId,
      ...rollups,
      raw: report,
      source: "quickbooks",
      pulled_at: nowIso,
      updated_at: nowIso,
    },
    { onConflict: "workspace_id,period_month" },
  );
  if (error) throw new Error(`upsert qb_pnl_snapshots ${month.periodMonth}: ${error.message}`);
  return { period_month: month.periodMonth, ...rollups };
}

/** Backfill the last `n` closed months (default 24) of P&L snapshots for a workspace. */
export async function backfillPnlSnapshots(
  workspaceId: string,
  n = 24,
  admin: Admin = createAdminClient(),
): Promise<(PnlRollups & { period_month: string })[]> {
  const months = lastClosedMonths(n, new Date());
  const results: (PnlRollups & { period_month: string })[] = [];
  for (const month of months) {
    results.push(await snapshotPnlMonth(workspaceId, month, admin));
  }
  return results;
}
