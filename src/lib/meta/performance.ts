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

/** Mirror campaign/adset/ad structure + budgets + status into our tables. */
export async function syncMetaStructure(p: SyncParams): Promise<{ campaigns: number; adsets: number; ads: number }> {
  const admin = createAdminClient();
  const acct = actId(p.metaAccountId);
  const now = new Date().toISOString();

  const campaigns = await graphGetAll(
    `${acct}/campaigns`,
    { fields: "id,name,status,effective_status,objective,daily_budget,lifetime_budget,created_time,updated_time", limit: "500" },
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
    { fields: "id,name,status,effective_status,campaign_id,optimization_goal,daily_budget,lifetime_budget,created_time,updated_time", limit: "500" },
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
    { fields: "id,name,status,effective_status,adset_id,campaign_id,creative,created_time,updated_time", limit: "500" },
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

/** Pull daily insights for one level over [startDate, endDate] and upsert per (object, day). */
export async function syncMetaInsightsForLevel(
  p: SyncParams,
  level: Level,
  startDate: string,
  endDate: string,
): Promise<{ rows: number }> {
  const admin = createAdminClient();
  const acct = actId(p.metaAccountId);
  const idField = OBJECT_ID_FIELD[level];
  const now = new Date().toISOString();

  const rows = await graphGetAll(
    `${acct}/insights`,
    {
      level,
      time_range: JSON.stringify({ since: startDate, until: endDate }),
      time_increment: "1",
      fields: `${idField},spend,impressions,clicks,ctr,cpc,frequency,actions,action_values`,
      limit: "500",
    },
    p.accessToken,
  );

  const records = rows
    .filter((r) => r[idField] && r.date_start)
    .map((r) => {
      const spendCents = dollarsToCents(r.spend);
      const purchaseAction = (r.actions || []).find((a: any) => a.action_type === "purchase");
      const purchaseValue = (r.action_values || []).find((a: any) => a.action_type === "purchase");
      const purchases = purchaseAction ? parseInt(purchaseAction.value, 10) || 0 : 0;
      const revenueCents = purchaseValue ? dollarsToCents(purchaseValue.value) : 0;
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
        revenue_cents: revenueCents,
        roas: spendCents > 0 ? revenueCents / spendCents : 0,
        frequency: num(r.frequency),
        synced_at: now,
        updated_at: now,
      };
    });

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
  const insights = await syncMetaInsights(p, startDate, endDate);

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

  return { backfilled, startDate, endDate, structure, insights, reconcile };
}
