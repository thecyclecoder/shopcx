/**
 * Ad-spend governor — the SUPERVISOR on the Growth director's ad-DOLLAR proxy
 * (growth-ad-spend-rail spec, Phase 2 of M3 — Spend rails of [[../goals/growth]]).
 *
 * Mirrors `fleet-spend-governor` (Max-lane TOKENS) for the ad-channel DOLLARS axis:
 * reads each effective `ad_spend_budgets` row vs the `daily_meta_ad_spend` rolling-
 * window sum and ESCALATES on a TREND over the ceiling (current window > 100% AND
 * yesterday's same-length window also above — never a single-day spike). Escalation
 * routes the diagnosis to the CEO via [[agents/platform-director]] `escalateDiagnosisToCeo`
 * (`escalationKind='ad_spend_ceiling'`) AND writes a growth-owned `director_activity`
 * row (`director_function='growth'`, `action_kind='escalated_ad_spend_ceiling'`).
 *
 * NEVER pauses, throttles, or kills a campaign — escalation only (operational-rules
 * § North star: hit a rail → escalate, never execute). The Director's leash boundary:
 * within-ceiling reallocation is autonomous; raising the ceiling is the CEO's call.
 *
 * Phase 1 laid down `ad_spend_budgets`. Phase 2 (this file) is the read+escalate side.
 * Phase 3 registers the cron + wires the brief loader.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { escalateDiagnosisToCeo } from "@/lib/agents/platform-director";
import { recordDirectorActivity } from "@/lib/director-activity";

type Admin = ReturnType<typeof createAdminClient>;

export type AdSpendPlatform = "meta" | "google" | "amazon";

/** The TS shape of an `ad_spend_budgets` row (snake → camel; `bigint` normalized to number). */
export interface AdSpendBudget {
  id: string;
  workspaceId: string;
  metaAdAccountId: string | null;
  platform: AdSpendPlatform;
  windowDays: number;
  usdCeilingCents: number;
  notes: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AdSpendBudgetRow {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  platform: string;
  window_days: number;
  usd_ceiling_cents: number | string; // bigint round-trips as string from PostgREST
  notes: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

function toBudget(row: AdSpendBudgetRow): AdSpendBudget {
  const uc = row.usd_ceiling_cents;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    metaAdAccountId: row.meta_ad_account_id,
    platform: row.platform as AdSpendPlatform,
    windowDays: row.window_days,
    usdCeilingCents: typeof uc === "string" ? Number(uc) : uc,
    notes: row.notes,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Every `ad_spend_budgets` row owned by the given workspace (the table is workspace-scoped). */
export async function listAdSpendBudgets(admin: Admin, workspaceId: string): Promise<AdSpendBudget[]> {
  const { data, error } = await admin.from("ad_spend_budgets").select("*").eq("workspace_id", workspaceId);
  if (error) throw error;
  return (data || []).map((r) => toBudget(r as AdSpendBudgetRow));
}

/**
 * The EFFECTIVE budget for one `(workspace, platform, metaAdAccountId)` tuple — the
 * MORE-SPECIFIC row wins: a per-account row (`meta_ad_account_id` set) beats the
 * platform-wide row (`meta_ad_account_id IS NULL`) for the same workspace+platform.
 * Returns null when neither exists.
 *
 * (The schema enforces `workspace_id NOT NULL`, so unlike `fleet_budgets` there is no
 * global default — the workspace axis is the outer envelope, the ad-account axis is
 * the inner override.)
 */
export async function getEffectiveAdSpendBudget(
  admin: Admin,
  workspaceId: string,
  args: { platform: AdSpendPlatform; metaAdAccountId?: string | null },
): Promise<AdSpendBudget | null> {
  const { platform, metaAdAccountId = null } = args;
  const { data, error } = await admin
    .from("ad_spend_budgets")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("platform", platform);
  if (error) throw error;
  const rows = (data || []).map((r) => toBudget(r as AdSpendBudgetRow));
  if (!rows.length) return null;
  if (metaAdAccountId) {
    const exact = rows.find((r) => r.metaAdAccountId === metaAdAccountId);
    if (exact) return exact;
  }
  return rows.find((r) => r.metaAdAccountId === null) ?? null;
}

/** One rolling-window rollup of actual ad spend ending on a given UTC day. */
export interface AdSpendRollup {
  /** Sum of `daily_meta_ad_spend.spend_cents` over [sinceDate, toDate] inclusive — 0 when no rows. */
  actualCents: number;
  /** UTC day the window ENDS on. */
  toDate: string;
  /** UTC day the window STARTS on (`toDate - (windowDays - 1)`). */
  sinceDate: string;
  /** Days summed (matches the caller's `windowDays`). */
  windowDays: number;
}

function shiftIsoDate(iso: string, deltaDays: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function todayIsoUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Sum `daily_meta_ad_spend.spend_cents` over a rolling [sinceDate, toDate] window
 * for one `(workspace_id, meta_ad_account_id)`. A null `metaAdAccountId` sums the
 * workspace's whole Meta spend in the window. Only `platform='meta'` is implemented
 * today — `daily_meta_ad_spend` is Meta-only, so a google/amazon budget returns 0
 * (the governor will simply never breach those until the per-platform spend tables
 * are wired in).
 */
export async function rollupAdSpendActual(
  admin: Admin,
  args: {
    workspaceId: string;
    platform: AdSpendPlatform;
    metaAdAccountId?: string | null;
    windowDays: number;
    /** UTC day the window ENDS on. Defaults to today (UTC). */
    asOfDate?: string;
  },
): Promise<AdSpendRollup> {
  const { workspaceId, platform, metaAdAccountId = null, windowDays } = args;
  const toDate = args.asOfDate ?? todayIsoUtc();
  const sinceDate = shiftIsoDate(toDate, -(windowDays - 1));
  if (platform !== "meta") {
    return { actualCents: 0, toDate, sinceDate, windowDays };
  }
  let q = admin
    .from("daily_meta_ad_spend")
    .select("spend_cents")
    .eq("workspace_id", workspaceId)
    .gte("snapshot_date", sinceDate)
    .lte("snapshot_date", toDate);
  if (metaAdAccountId) q = q.eq("meta_ad_account_id", metaAdAccountId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as { spend_cents: number | string | null }[];
  const actualCents = rows.reduce((sum, r) => {
    const v = r.spend_cents;
    if (v == null) return sum;
    return sum + (typeof v === "string" ? Number(v) : v);
  }, 0);
  return { actualCents, toDate, sinceDate, windowDays };
}

// ── Escalation ─────────────────────────────────────────────────────────────────────────

/** The Growth director's function slug (mirrors `PLATFORM` in platform-director). */
const GROWTH_DIRECTOR_FUNCTION = "growth";

/** The CEO's deep-link target for an ad-spend escalation (Marketing → Ads). */
const AD_SPEND_DEEP_LINK = "/dashboard/marketing/ads";

/** Per-budget observation snapshot — for cron heartbeats + the Phase-3 director-brief. */
export interface AdSpendBudgetObservation {
  budget: AdSpendBudget;
  /** Today's window total (ending today, UTC). */
  current: AdSpendRollup;
  /** Yesterday's same-length window total (ending yesterday, UTC) — the prior day in the trend. */
  prior: AdSpendRollup;
  /** Current window total exceeds the ceiling. */
  currentOver: boolean;
  /** Prior window total exceeds the ceiling — together with `currentOver` = a trend over. */
  priorOver: boolean;
  /** Both `currentOver` AND `priorOver` — the 2-day rolling-above trend that triggers escalation. */
  trendOver: boolean;
}

export interface AdSpendGovernorPassResult {
  /** Distinct budgets evaluated this pass. */
  observed: number;
  /** Newly-emitted CEO escalations (one notification + one growth director_activity row per breach). */
  escalations: number;
  /** Per-budget observation rows. */
  observations: AdSpendBudgetObservation[];
}

/** Stable per-budget dedupe key — one OPEN CEO escalation per (workspace, platform, account), ever. */
function adSpendDedupeKey(b: AdSpendBudget): string {
  return `ad_spend_ceiling:${b.workspaceId}:${b.platform}:${b.metaAdAccountId ?? "all"}`;
}

/** The human "how far over" string used by both the CEO notification body + the growth activity reason. */
function adSpendReason(o: AdSpendBudgetObservation): string {
  const scope = o.budget.metaAdAccountId ? `account ${o.budget.metaAdAccountId}` : `${o.budget.platform}-wide`;
  const pctNow = Math.round((o.current.actualCents / o.budget.usdCeilingCents) * 100);
  const pctPrior = Math.round((o.prior.actualCents / o.budget.usdCeilingCents) * 100);
  const usdNow = (o.current.actualCents / 100).toFixed(2);
  const usdPrior = (o.prior.actualCents / 100).toFixed(2);
  const usdCeil = (o.budget.usdCeilingCents / 100).toFixed(2);
  return (
    `Ad spend ceiling breach: ${scope} ${o.budget.windowDays}d window over the $${usdCeil} ceiling for 2 consecutive days ` +
    `(today $${usdNow} = ${pctNow}%, ending ${o.current.toDate}; yesterday $${usdPrior} = ${pctPrior}%, ending ${o.prior.toDate}). ` +
    `Director's leash boundary — within-ceiling reallocation is autonomous; raising the ceiling is your call.`
  );
}

async function escalateAdSpendBreach(admin: Admin, observation: AdSpendBudgetObservation): Promise<{ emitted: boolean }> {
  const { budget, current } = observation;
  const accountSuffix = budget.metaAdAccountId ? ` / ${budget.metaAdAccountId.slice(0, 8)}` : "";
  const title = `Ad spend ceiling: ${budget.platform}${accountSuffix}`;
  const diagnosis = adSpendReason(observation);
  const dedupeKey = adSpendDedupeKey(budget);
  const metadata = {
    platform: budget.platform,
    meta_ad_account_id: budget.metaAdAccountId,
    window_days: budget.windowDays,
    actual_cents: current.actualCents,
    ceiling_cents: budget.usdCeilingCents,
  } as const;

  // CEO Approval Request via the shared platform-director helper. The helper is notification-first,
  // dedupe-checks on an EXISTING `dashboard_notifications` row keyed on `dedupe_key`, and writes its
  // OWN platform-owned `escalated` ledger row only when the notification actually landed.
  const ceo = await escalateDiagnosisToCeo(admin, {
    workspaceId: budget.workspaceId,
    specSlug: null,
    title,
    diagnosis,
    dedupeKey,
    deepLink: AD_SPEND_DEEP_LINK,
    escalationKind: "ad_spend_ceiling",
    metadata,
  });
  if (!ceo.emitted) {
    // Either dedup held (a prior escalation is still surfaced) or the notification insert failed —
    // either way we do NOT write the growth ledger row this pass (no double-counting an existing
    // breach, no phantom row for a never-surfaced escalation).
    return { emitted: false };
  }

  // The growth-owned `director_activity` the spec calls for — the per-breach Growth audit trail.
  // Distinct from the helper's platform-owned `escalated` row (that records "who pinged the CEO";
  // this records "Growth identified an ad-spend ceiling breach" with the per-breach metadata).
  await recordDirectorActivity(admin, {
    workspaceId: budget.workspaceId,
    directorFunction: GROWTH_DIRECTOR_FUNCTION,
    actionKind: "escalated_ad_spend_ceiling",
    specSlug: null,
    reason: diagnosis,
    metadata: { ...metadata, dedupe_key: dedupeKey, autonomous: true },
  });
  return { emitted: true };
}

async function evaluateBudget(admin: Admin, budget: AdSpendBudget): Promise<AdSpendBudgetObservation> {
  const today = todayIsoUtc();
  const yesterday = shiftIsoDate(today, -1);
  const current = await rollupAdSpendActual(admin, {
    workspaceId: budget.workspaceId,
    platform: budget.platform,
    metaAdAccountId: budget.metaAdAccountId,
    windowDays: budget.windowDays,
    asOfDate: today,
  });
  const prior = await rollupAdSpendActual(admin, {
    workspaceId: budget.workspaceId,
    platform: budget.platform,
    metaAdAccountId: budget.metaAdAccountId,
    windowDays: budget.windowDays,
    asOfDate: yesterday,
  });
  const currentOver = current.actualCents > budget.usdCeilingCents;
  const priorOver = prior.actualCents > budget.usdCeilingCents;
  return { budget, current, prior, currentOver, priorOver, trendOver: currentOver && priorOver };
}

/**
 * Read every `ad_spend_budgets` row (workspace-scoped when `opts.workspaceId` is set; all workspaces
 * otherwise), roll up the actual spend over TWO consecutive same-length windows (today + yesterday),
 * and ESCALATE on a trend over — current window > 100% AND the prior window also > 100% (no single-
 * day spike triggers a page). NEVER throttles or pauses a campaign — the breach surfaces to the CEO
 * via `escalateDiagnosisToCeo` + a growth `director_activity` row (`escalated_ad_spend_ceiling`).
 *
 * Loop-guarded by `escalateDiagnosisToCeo`'s `dedupe_key` check — one OPEN ceiling notification per
 * (workspace, platform, account) at a time; once the CEO dismisses it, a still-breaching budget
 * re-surfaces on the next sweep.
 */
export async function runAdSpendGovernorPass(
  admin: Admin,
  opts?: { workspaceId?: string },
): Promise<AdSpendGovernorPassResult> {
  let q = admin.from("ad_spend_budgets").select("*");
  if (opts?.workspaceId) q = q.eq("workspace_id", opts.workspaceId);
  const { data, error } = await q;
  if (error) throw error;
  const budgets = (data || []).map((r) => toBudget(r as AdSpendBudgetRow));
  if (budgets.length === 0) return { observed: 0, escalations: 0, observations: [] };

  const observations: AdSpendBudgetObservation[] = [];
  for (const b of budgets) {
    observations.push(await evaluateBudget(admin, b));
  }

  let escalations = 0;
  for (const o of observations) {
    if (!o.trendOver) continue;
    const r = await escalateAdSpendBreach(admin, o);
    if (r.emitted) escalations++;
  }
  return { observed: observations.length, escalations, observations };
}
