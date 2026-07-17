/**
 * Meta performance ingestion (Graph v21.0) — Storefront Iteration Engine Phase 1.
 *
 * The READ half the iteration engine needs: mirror Meta's campaign/adset/ad
 * STRUCTURE into `meta_campaigns`/`meta_adsets`/`meta_ads`, and pull daily
 * INSIGHTS at object grain into `meta_insights_daily`. None of this was stored
 * before — only the account-level `daily_meta_ad_spend` rollup existed.
 *
 * Idempotent: structure upserts on the Meta object id; insights upsert on
 * (workspace_id, meta_object_id, level, snapshot_date). Re-running a day never
 * double-writes. The account id is stored BARE on `meta_ad_accounts.meta_account_id`;
 * the client prefixes `act_`. Token comes from `getMetaUserToken()` in meta-ads.ts.
 *
 * See docs/brain/specs/storefront-iteration-engine.md (Phase 1).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { graphFetchJson } from "@/lib/meta/graph-retry";
import { reportDbError } from "@/lib/control-tower/error-feed";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";
const actId = (id: string) => (id.startsWith("act_") ? id : `act_${id.replace(/^act_/, "")}`);

type Admin = ReturnType<typeof createAdminClient>;

/**
 * Upsert in ≤500-row chunks and return the count actually PERSISTED — never the
 * count attempted. A non-null Supabase `{ error }` is the silent-write class this
 * spec exists to kill (meta-insights-ingest-empty-fix): the old code ignored it
 * and returned `records.length`, so a run could page through Meta for two minutes,
 * fail every upsert, and still report success with 0 rows written. Now we surface
 * the swallowed error to the Control Tower feed (reportDbError) at the source and
 * throw loudly with the PG code+message so the run fails instead of lying.
 */
async function upsertOrThrow(
  admin: Admin,
  table: string,
  rows: Record<string, unknown>[],
  onConflict: string,
  ctx: { op: string; label?: string; extra?: Record<string, unknown> },
): Promise<number> {
  let persisted = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const { error } = await admin.from(table).upsert(chunk, { onConflict });
    if (error) {
      await reportDbError(error, { op: ctx.op, table, ...(ctx.extra ?? {}), persisted, total: rows.length });
      throw new Error(
        `${table} upsert failed${ctx.label ? ` (${ctx.label})` : ""}: ${(error as { code?: string }).code ?? "?"} ` +
          `${error.message} — persisted ${persisted}/${rows.length} before the error`,
      );
    }
    persisted += chunk.length;
  }
  return persisted;
}

type Level = "campaign" | "adset" | "ad";

async function graphGet(path: string, params: Record<string, string>, token: string): Promise<any> {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);
  // Retries transient Meta errors (code 1/2, is_transient, 429, 5xx) with
  // bounded backoff so a routine wobble no longer fails the daily run; fatal
  // errors (token/permission/validation) still fail fast. See graph-retry.ts.
  return graphFetchJson(() => fetch(url.toString()), `GET ${path}`);
}

/** POST to a Graph edge (used to submit an async insights report). Same retry/backoff as GET. */
async function graphPost(path: string, params: Record<string, string>, token: string): Promise<any> {
  const url = new URL(`${GRAPH_BASE}/${path}`);
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.set(k, v);
  body.set("access_token", token);
  return graphFetchJson(() => fetch(url.toString(), { method: "POST", body }), `POST ${path}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Page through a Graph edge, following cursor pagination, collecting all rows. */
async function graphGetAll(path: string, params: Record<string, string>, token: string): Promise<any[]> {
  const rows: any[] = [];
  let after: string | null = null;
  do {
    const data = await graphGet(path, after ? { ...params, after } : params, token);
    rows.push(...(data.data || []));
    after = data.paging?.next ? data.paging?.cursors?.after || null : null;
  } while (after);
  return rows;
}

const toCents = (v: unknown): number | null => {
  if (v == null || v === "") return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n) : null; // Meta budgets are already minor units
};
const dollarsToCents = (v: unknown): number => {
  const n = parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const num = (v: unknown): number => {
  const n = parseFloat(String(v ?? "0"));
  return Number.isFinite(n) ? n : 0;
};
const isoOrNull = (v: unknown): string | null => (v ? new Date(String(v)).toISOString() : null);

interface SyncParams {
  workspaceId: string;
  adAccountId: string; // our DB uuid
  metaAccountId: string; // Meta numeric id (bare)
  accessToken: string;
}

// ── Structure ────────────────────────────────────────────────────────────────

/** Mirror campaign/adset/ad structure + budgets + status into our tables.
 * `opts.campaignIds` scopes the pull to specific Meta campaigns (the intraday test-cadence path pulls
 * ONLY the media-buyer test campaigns, not the whole account) via Graph `filtering`. */
export async function syncMetaStructure(
  p: SyncParams,
  opts?: { campaignIds?: string[] },
): Promise<{ campaigns: number; adsets: number; ads: number }> {
  const admin = createAdminClient();
  const acct = actId(p.metaAccountId);
  const now = new Date().toISOString();
  const scoped = opts?.campaignIds && opts.campaignIds.length > 0 ? opts.campaignIds : null;
  const campFilter: Record<string, string> = scoped ? { filtering: JSON.stringify([{ field: "id", operator: "IN", value: scoped }]) } : {};
  const byCampaign: Record<string, string> = scoped ? { filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: scoped }]) } : {};

  const campaigns = await graphGetAll(
    `${acct}/campaigns`,
    { fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,updated_time", limit: "500", ...campFilter },
    p.accessToken,
  );
  const campaignsPersisted = campaigns.length
    ? await upsertOrThrow(
        admin,
        "meta_campaigns",
        campaigns.map((c) => ({
          workspace_id: p.workspaceId,
          meta_ad_account_id: p.adAccountId,
          meta_campaign_id: c.id,
          name: c.name ?? null,
          status: c.status ?? null,
          effective_status: c.effective_status ?? null,
          objective: c.objective ?? null,
          daily_budget_cents: toCents(c.daily_budget),
          lifetime_budget_cents: toCents(c.lifetime_budget),
          meta_created_time: isoOrNull(c.created_time),
          meta_updated_time: isoOrNull(c.updated_time),
          synced_at: now,
          updated_at: now,
        })),
        "workspace_id,meta_campaign_id",
        { op: "meta-structure-upsert", label: "campaigns", extra: { account: p.adAccountId } },
      )
    : 0;

  const adsets = await graphGetAll(
    `${acct}/adsets`,
    { fields: "id,name,status,effective_status,campaign_id,optimization_goal,daily_budget,lifetime_budget,created_time,updated_time", limit: "500", ...byCampaign },
    p.accessToken,
  );
  const adsetsPersisted = adsets.length
    ? await upsertOrThrow(
        admin,
        "meta_adsets",
        adsets.map((a) => ({
          workspace_id: p.workspaceId,
          meta_ad_account_id: p.adAccountId,
          meta_adset_id: a.id,
          meta_campaign_id: a.campaign_id ?? null,
          name: a.name ?? null,
          status: a.status ?? null,
          effective_status: a.effective_status ?? null,
          optimization_goal: a.optimization_goal ?? null,
          daily_budget_cents: toCents(a.daily_budget),
          lifetime_budget_cents: toCents(a.lifetime_budget),
          meta_created_time: isoOrNull(a.created_time),
          meta_updated_time: isoOrNull(a.updated_time),
          synced_at: now,
          updated_at: now,
        })),
        "workspace_id,meta_adset_id",
        { op: "meta-structure-upsert", label: "adsets", extra: { account: p.adAccountId } },
      )
    : 0;

  const ads = await graphGetAll(
    `${acct}/ads`,
    { fields: "id,name,status,effective_status,adset_id,campaign_id,creative,created_time,updated_time", limit: "500", ...byCampaign },
    p.accessToken,
  );
  const adsPersisted = ads.length
    ? await upsertOrThrow(
        admin,
        "meta_ads",
        ads.map((a) => ({
          workspace_id: p.workspaceId,
          meta_ad_account_id: p.adAccountId,
          meta_ad_id: a.id,
          meta_adset_id: a.adset_id ?? null,
          meta_campaign_id: a.campaign_id ?? null,
          name: a.name ?? null,
          status: a.status ?? null,
          effective_status: a.effective_status ?? null,
          creative_id: a.creative?.id ?? null,
          meta_created_time: isoOrNull(a.created_time),
          meta_updated_time: isoOrNull(a.updated_time),
          synced_at: now,
          updated_at: now,
        })),
        "workspace_id,meta_ad_id",
        { op: "meta-structure-upsert", label: "ads", extra: { account: p.adAccountId } },
      )
    : 0;

  return { campaigns: campaignsPersisted, adsets: adsetsPersisted, ads: adsPersisted };
}

// ── Insights ─────────────────────────────────────────────────────────────────

const OBJECT_ID_FIELD: Record<Level, string> = { campaign: "campaign_id", adset: "adset_id", ad: "ad_id" };

/** Fields requested for an insights pull at `level` (sync GET and async report alike). */
const insightsFields = (level: Level) =>
  `${OBJECT_ID_FIELD[level]},spend,impressions,clicks,ctr,cpc,frequency,actions,action_values,inline_link_clicks`;

/**
 * Map raw Graph insight rows → `meta_insights_daily` records. Shared by the sync
 * GET path ([[syncMetaInsightsForLevel]]) and the async-report path
 * ([[syncMetaInsightsForLevelAsync]]) so both land byte-identical rows — the spec's
 * "lands rows across all three levels … idempotency unchanged" invariant.
 */
export function mapInsightsRecords(p: SyncParams, level: Level, rows: any[], now: string): Record<string, unknown>[] {
  const idField = OBJECT_ID_FIELD[level];
  return rows
    .filter((r) => r[idField] && r.date_start)
    .map((r) => {
      const spendCents = dollarsToCents(r.spend);
      const purchaseAction = (r.actions || []).find((a: any) => a.action_type === "purchase");
      const purchaseValue = (r.action_values || []).find((a: any) => a.action_type === "purchase");
      const purchases = purchaseAction ? parseInt(purchaseAction.value, 10) || 0 : 0;
      const revenueCents = purchaseValue ? dollarsToCents(purchaseValue.value) : 0;
      // Add-to-cart (media-buyer-early-trim-on-cost-per-atc): cost-per-ATC is the strongest LEADING
      // laggard signal (validated on Amazing Coffee — winners $18–65/ATC, laggards $100–152). Prefer the
      // aggregated `add_to_cart`, fall back to omni / pixel variants Meta may report instead.
      const atcAction = (r.actions || []).find((a: any) =>
        a.action_type === "add_to_cart" || a.action_type === "omni_add_to_cart" || a.action_type === "offsite_conversion.fb_pixel_add_to_cart",
      );
      const addToCart = atcAction ? parseInt(atcAction.value, 10) || 0 : 0;
      // Meta's `inline_link_clicks` — clicks that reached the ad's landing_url (excludes
      // video-thumb taps, engagement clicks, CTA-only clicks). NULLABLE-MEANS-UNKNOWN:
      // when Meta omits the field, leave it null so per-mode CTR readers can EXCLUDE it
      // rather than treating a missing value as 0 (docs/brain/specs/dahlia-cold-graded-
      // inline-link-ctr-leading-signal.md Phase 1).
      const inlineLinkClicksRaw = r.inline_link_clicks;
      const inlineLinkClicks =
        inlineLinkClicksRaw == null || inlineLinkClicksRaw === ""
          ? null
          : parseInt(String(inlineLinkClicksRaw), 10) || 0;
      return {
        workspace_id: p.workspaceId,
        meta_ad_account_id: p.adAccountId,
        level,
        meta_object_id: String(r[idField]),
        snapshot_date: r.date_start,
        spend_cents: spendCents,
        impressions: parseInt(r.impressions || "0", 10) || 0,
        clicks: parseInt(r.clicks || "0", 10) || 0,
        ctr: num(r.ctr),
        cpc_cents: dollarsToCents(r.cpc),
        purchases,
        add_to_cart: addToCart,
        inline_link_clicks: inlineLinkClicks,
        revenue_cents: revenueCents,
        roas: spendCents > 0 ? revenueCents / spendCents : 0,
        frequency: num(r.frequency),
        synced_at: now,
        updated_at: now,
      };
    });
}

/** Pull daily insights for one level over [startDate, endDate] and upsert per (object, day). */
export async function syncMetaInsightsForLevel(
  p: SyncParams,
  level: Level,
  startDate: string,
  endDate: string,
  opts?: { campaignIds?: string[] },
): Promise<{ rows: number }> {
  const admin = createAdminClient();
  const acct = actId(p.metaAccountId);
  const now = new Date().toISOString();
  const scoped = opts?.campaignIds && opts.campaignIds.length > 0 ? opts.campaignIds : null;

  const rows = await graphGetAll(
    `${acct}/insights`,
    {
      level,
      time_range: JSON.stringify({ since: startDate, until: endDate }),
      time_increment: "1",
      fields: insightsFields(level),
      limit: "500",
      // Intraday test-cadence: pull ONLY the media-buyer test campaigns, not the whole account.
      ...(scoped ? { filtering: JSON.stringify([{ field: "campaign.id", operator: "IN", value: scoped }]) } : {}),
    },
    p.accessToken,
  );

  const records = mapInsightsRecords(p, level, rows, now);

  // Chunk to stay well under statement/payload limits on a 90-day backfill, and
  // return the count actually PERSISTED — a swallowed upsert error here was the
  // root of the empty-insights regression (rows fetched, 0 written, status 'ok').
  const persisted = records.length
    ? await upsertOrThrow(admin, "meta_insights_daily", records, "workspace_id,meta_object_id,level,snapshot_date", {
        op: "meta-insights-upsert",
        label: level,
        extra: { account: p.adAccountId, level, since: startDate, until: endDate },
      })
    : 0;

  return { rows: persisted };
}

/** Max span of a single insights sub-window — keeps each Graph request light. */
const MAX_INSIGHTS_WINDOW_DAYS = 14;

/**
 * Slice [startDate, endDate] into sub-windows of ≤ MAX_INSIGHTS_WINDOW_DAYS,
 * ordered NEWEST-FIRST so the most recent (decision-relevant) days land before
 * older history if a long backfill is interrupted.
 */
function sliceInsightsWindows(startDate: string, endDate: string): { since: string; until: string }[] {
  const startMs = Date.parse(startDate);
  const slices: { since: string; until: string }[] = [];
  let untilMs = Date.parse(endDate);
  while (untilMs >= startMs) {
    const sinceMs = Math.max(startMs, untilMs - (MAX_INSIGHTS_WINDOW_DAYS - 1) * 86400000);
    slices.push({ since: dayStr(new Date(sinceMs)), until: dayStr(new Date(untilMs)) });
    untilMs = sinceMs - 86400000; // step to the day before this slice's start
  }
  return slices;
}

/**
 * Pull all three levels of insights for the date window. The window is sliced
 * into ≤14-day sub-windows (newest-first) and each (sub-window × level) is pulled
 * and upserted independently — so the first-run 90-day backfill never issues one
 * heavy synchronous request (which trips Meta's transient code 2 "Service
 * temporarily unavailable"), and partial progress is durable: rows already
 * written persist if a later slice fails, and the next run self-heals to the
 * light incremental path (`ingestMetaPerformance` flips `backfilled` off once any
 * `meta_insights_daily` row exists).
 */
export async function syncMetaInsights(
  p: SyncParams,
  startDate: string,
  endDate: string,
): Promise<{ campaign: number; adset: number; ad: number }> {
  const levels: Level[] = ["campaign", "adset", "ad"];
  const totals = { campaign: 0, adset: 0, ad: 0 };
  // Slice outer, level inner: the most recent days for ALL levels land first.
  for (const slice of sliceInsightsWindows(startDate, endDate)) {
    for (const level of levels) {
      const r = await syncMetaInsightsForLevel(p, level, slice.since, slice.until);
      totals[level] += r.rows;
    }
  }
  return totals;
}

// ── Async insights reports (large first-run backfills) ─────────────────────────

/**
 * Meta's sanctioned path for heavy insights pulls (iteration-ingest-async-reports).
 * For a brand-new account backfilling *years* of history, even the ≤14-day chunked
 * synchronous GETs (P2) can strain — long ranges × 3 levels trip Meta's transient
 * code 2 "Service temporarily unavailable" or rate-limit the GET volume. Meta
 * instead lets us SUBMIT an async report (`POST /act_{id}/insights` → `report_run_id`),
 * POLL it to completion, then PAGE the results once — one heavy job server-side
 * rather than dozens of synchronous round-trips.
 *
 * Flag-gated per account ([[isAsyncBackfillEnabled]]) and used ONLY for the
 * first-run backfill window; the small daily incremental window keeps the light
 * synchronous GET (async submit/poll overhead isn't worth 3 days). Output is fed
 * through the SAME `mapInsightsRecords` + `upsertOrThrow`, so idempotency and the
 * rows-written assertion are unchanged.
 */
const ASYNC_POLL_INTERVAL_MS = 5_000;
const ASYNC_POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 min ceiling per (level) report

/** Submit an async insights report for one level/window; returns Meta's `report_run_id`. */
async function submitInsightsReport(p: SyncParams, level: Level, startDate: string, endDate: string): Promise<string> {
  const acct = actId(p.metaAccountId);
  const res = await graphPost(
    `${acct}/insights`,
    {
      level,
      time_range: JSON.stringify({ since: startDate, until: endDate }),
      time_increment: "1",
      fields: insightsFields(level),
    },
    p.accessToken,
  );
  const reportRunId = res?.report_run_id ? String(res.report_run_id) : null;
  if (!reportRunId) {
    throw new Error(
      `Meta async insights submit returned no report_run_id (level=${level}, ${startDate}..${endDate}, account ${p.adAccountId})`,
    );
  }
  return reportRunId;
}

/**
 * Poll `GET /{report_run_id}` until the job completes. Meta reports progress in
 * `async_status` ('Job Not Started' → 'Job Started' → 'Job Running' → 'Job Completed';
 * 'Job Failed'/'Job Skipped' are terminal failures). Throws on a failed/skipped job
 * or once the poll timeout is exhausted (a stuck report is a loud failure, not a
 * silent hang — the engine's supervisable-not-silent invariant).
 */
async function pollInsightsReport(reportRunId: string, token: string): Promise<void> {
  const deadline = Date.now() + ASYNC_POLL_TIMEOUT_MS;
  for (;;) {
    const status = await graphGet(reportRunId, {}, token);
    // Real Graph field is `async_status`; tolerate `job_status` defensively.
    const jobStatus: string = status?.async_status ?? status?.job_status ?? "";
    if (jobStatus === "Job Completed") return;
    if (jobStatus === "Job Failed" || jobStatus === "Job Skipped") {
      throw new Error(`Meta async insights report ${reportRunId} ${jobStatus} (${status?.async_percent_completion ?? "?"}%)`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Meta async insights report ${reportRunId} did not complete within ${ASYNC_POLL_TIMEOUT_MS / 1000}s ` +
          `(last status '${jobStatus || "unknown"}', ${status?.async_percent_completion ?? "?"}%)`,
      );
    }
    await sleep(ASYNC_POLL_INTERVAL_MS);
  }
}

/** Pull one level over [startDate, endDate] via an async report, then upsert per (object, day). */
export async function syncMetaInsightsForLevelAsync(
  p: SyncParams,
  level: Level,
  startDate: string,
  endDate: string,
): Promise<{ rows: number }> {
  const admin = createAdminClient();
  const now = new Date().toISOString();

  const reportRunId = await submitInsightsReport(p, level, startDate, endDate);
  await pollInsightsReport(reportRunId, p.accessToken);
  // Page the completed report's results — same cursor pagination + row shape as the GET path.
  const rows = await graphGetAll(`${reportRunId}/insights`, { limit: "500" }, p.accessToken);

  const records = mapInsightsRecords(p, level, rows, now);
  const persisted = records.length
    ? await upsertOrThrow(admin, "meta_insights_daily", records, "workspace_id,meta_object_id,level,snapshot_date", {
        op: "meta-insights-upsert-async",
        label: level,
        extra: { account: p.adAccountId, level, since: startDate, until: endDate, report_run_id: reportRunId },
      })
    : 0;

  return { rows: persisted };
}

/**
 * Async-report variant of [[syncMetaInsights]] for the first-run backfill window.
 * One async report per level over the FULL range (Meta does the chunking
 * server-side — no client-side ≤14-day slicing needed). Returns the same
 * per-level persisted-row totals so the caller's rows-written assertion is unchanged.
 */
export async function syncMetaInsightsAsync(
  p: SyncParams,
  startDate: string,
  endDate: string,
): Promise<{ campaign: number; adset: number; ad: number }> {
  const levels: Level[] = ["campaign", "adset", "ad"];
  const totals = { campaign: 0, adset: 0, ad: 0 };
  for (const level of levels) {
    const r = await syncMetaInsightsForLevelAsync(p, level, startDate, endDate);
    totals[level] += r.rows;
  }
  return totals;
}

/**
 * Per-account flag: is the async-report backfill path enabled for this account?
 * Stored on `meta_ad_accounts.async_insights_backfill_enabled` (default false), so
 * the path ships dark and is flipped on only where the large-backfill pain is real.
 * Reads DEFENSIVELY — if the column isn't present yet (migration not applied) or the
 * row is missing, treat as disabled rather than failing the ingest. Off → the sync
 * chunked GET path (P2) handles the backfill exactly as before.
 */
export async function isAsyncBackfillEnabled(admin: Admin, adAccountId: string): Promise<boolean> {
  const { data, error } = await admin
    .from("meta_ad_accounts")
    .select("async_insights_backfill_enabled")
    .eq("id", adAccountId)
    .maybeSingle();
  if (error) return false; // column absent (pre-migration) or query failed → disabled
  return data?.async_insights_backfill_enabled === true;
}

// ── Reconciliation ─────────────────────────────────────────────────────────--

export interface ReconcileDrift {
  snapshot_date: string;
  insights_spend_cents: number; // sum of campaign-level insights for the day
  rollup_spend_cents: number; // daily_meta_ad_spend for the day
  diff_cents: number;
  diff_pct: number;
}

/**
 * Sanity check: per day, sum campaign-level insights spend and compare to the
 * existing `daily_meta_ad_spend` account rollup. Flag any day whose drift
 * exceeds the tolerance (default: >$1 AND >2%). Surfaced, never silent.
 */
export async function reconcileInsightsVsSpend(
  p: SyncParams,
  startDate: string,
  endDate: string,
  tolerance = { absCents: 100, pct: 0.02 },
): Promise<{ daysChecked: number; drift: ReconcileDrift[] }> {
  const admin = createAdminClient();

  const { data: insights } = await admin
    .from("meta_insights_daily")
    .select("snapshot_date, spend_cents")
    .eq("meta_ad_account_id", p.adAccountId)
    .eq("level", "campaign")
    .gte("snapshot_date", startDate)
    .lte("snapshot_date", endDate);

  const { data: rollup } = await admin
    .from("daily_meta_ad_spend")
    .select("snapshot_date, spend_cents")
    .eq("meta_ad_account_id", p.adAccountId)
    .gte("snapshot_date", startDate)
    .lte("snapshot_date", endDate);

  const insightsByDay = new Map<string, number>();
  for (const r of insights || []) insightsByDay.set(r.snapshot_date, (insightsByDay.get(r.snapshot_date) || 0) + (r.spend_cents || 0));
  const rollupByDay = new Map<string, number>();
  for (const r of rollup || []) rollupByDay.set(r.snapshot_date, r.spend_cents || 0);

  // Only reconcile days the rollup actually covers — a day absent from
  // daily_meta_ad_spend is missing reference data (e.g. the 90-day backfill
  // outruns the 3-day rollup cron), not genuine drift.
  const days = rollupByDay;
  const drift: ReconcileDrift[] = [];
  for (const day of days.keys()) {
    const insightsSpend = insightsByDay.get(day) || 0;
    const rollupSpend = rollupByDay.get(day) || 0;
    const diff = Math.abs(insightsSpend - rollupSpend);
    const base = Math.max(insightsSpend, rollupSpend, 1);
    const pct = diff / base;
    if (diff > tolerance.absCents && pct > tolerance.pct) {
      drift.push({
        snapshot_date: day,
        insights_spend_cents: insightsSpend,
        rollup_spend_cents: rollupSpend,
        diff_cents: insightsSpend - rollupSpend,
        diff_pct: Number(pct.toFixed(4)),
      });
    }
  }
  drift.sort((a, b) => (a.snapshot_date < b.snapshot_date ? -1 : 1));
  return { daysChecked: days.size, drift };
}

// ── Orchestration ──────────────────────────────────────────────────────────--

const dayStr = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Full Phase 1 ingest for one account: structure → insights → reconcile.
 * Backfills 90 days on first run (no insights rows yet), else an incremental
 * window (default 3 days, to catch Meta's late-reporting attribution).
 */
export async function ingestMetaPerformance(
  p: SyncParams,
  opts?: { incrementalDays?: number; backfillDays?: number },
): Promise<{
  backfilled: boolean;
  asyncBackfill: boolean;
  startDate: string;
  endDate: string;
  structure: { campaigns: number; adsets: number; ads: number };
  insights: { campaign: number; adset: number; ad: number };
  reconcile: { daysChecked: number; drift: ReconcileDrift[] };
}> {
  const admin = createAdminClient();

  const { count } = await admin
    .from("meta_insights_daily")
    .select("id", { count: "exact", head: true })
    .eq("meta_ad_account_id", p.adAccountId);
  const backfilled = !count;

  const windowDays = backfilled ? opts?.backfillDays ?? 90 : opts?.incrementalDays ?? 3;
  const endDate = dayStr(new Date());
  const startDate = dayStr(new Date(Date.now() - (windowDays - 1) * 86400000));

  const structure = await syncMetaStructure(p);

  // For the first-run backfill window only, prefer Meta's async-report path when the
  // per-account flag is on (iteration-ingest-async-reports) — a years-long first
  // backfill can strain even the ≤14-day chunked synchronous GETs. The small daily
  // incremental window always keeps the light synchronous path (async overhead isn't
  // worth 3 days). Both feed the same map+upsert, so the assertion below is unchanged.
  const useAsyncBackfill = backfilled && (await isAsyncBackfillEnabled(admin, p.adAccountId));
  const insights = useAsyncBackfill
    ? await syncMetaInsightsAsync(p, startDate, endDate)
    : await syncMetaInsights(p, startDate, endDate);

  // ── Output assertion — rows-written > 0 when Meta has data (the false-success
  // class this spec exists to kill). The ingest used to report success even when
  // it persisted 0 insight rows. We cross-check against the INDEPENDENT
  // `daily_meta_ad_spend` account rollup (a different feed, populated by the
  // account-level spend sync): if that rollup proves the account spent in this
  // window but we wrote 0 ad/adset/campaign insight rows, the object-grain ingest
  // silently produced nothing — wrong `act_` id / a dropped ads_read scope on the
  // token / a swallowed write — so we surface it to the Control Tower and fail
  // loud. An account that genuinely had no Meta spend → 0 rollup spend → 0 rows is
  // correct and stays silent (the negative case the spec calls out).
  const insightRows = insights.campaign + insights.adset + insights.ad;
  if (insightRows === 0) {
    const { data: rollup } = await admin
      .from("daily_meta_ad_spend")
      .select("spend_cents")
      .eq("meta_ad_account_id", p.adAccountId)
      .gte("snapshot_date", startDate)
      .lte("snapshot_date", endDate);
    const rollupSpendCents = (rollup || []).reduce((s, r) => s + (r.spend_cents || 0), 0);
    if (rollupSpendCents > 0) {
      const detail =
        `Meta insights ingest persisted 0 ad/adset/campaign rows for account ${p.adAccountId} over ` +
        `${startDate}..${endDate}, but daily_meta_ad_spend shows ${rollupSpendCents}¢ of account spend in that ` +
        `window — Meta has data while meta_insights_daily is empty (false-success). Check the active ` +
        `meta_ad_account_id / token ads_read scope / the act_ id the insights endpoint is queried with.`;
      // Surface the swallowed false-success to the Control Tower error feed at the
      // source (best-effort) before throwing so the run fails loudly.
      await reportDbError(
        { code: "META_INGEST_EMPTY", message: detail },
        {
          op: "meta-ingest-false-success",
          table: "meta_insights_daily",
          account: p.adAccountId,
          rollup_spend_cents: rollupSpendCents,
          window: `${startDate}..${endDate}`,
          structure,
        },
      );
      throw new Error(detail);
    }
  }

  const reconcile = await reconcileInsightsVsSpend(p, startDate, endDate);

  return { backfilled, asyncBackfill: useAsyncBackfill, startDate, endDate, structure, insights, reconcile };
}
