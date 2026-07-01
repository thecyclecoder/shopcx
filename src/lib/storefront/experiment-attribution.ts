/**
 * Storefront experiment outcome attribution — Phase 3 of the storefront experiment
 * + bandit framework, REWRITTEN by experiment-session-stamped-attribution.
 *
 * Persists per-variant rollups (sessions, conversions, sub-attach, revenue, LTV-proxy)
 * + the Thompson-sampling posterior onto [[storefront_experiment_variants]].
 *
 * Attribution spine — session-stamped, literal, no client-event guesswork:
 *   1. A variant's SESSIONS = `storefront_sessions` whose `experiment_assignments`
 *      carries that variant's arm, EXCLUDING is_internal / is_bot (the report-layer
 *      exclusion — internal/bot are still stamped, just not counted). The stamp is
 *      written server/edge-side off the resolved arm (sx_variant cookie /
 *      resolveExperimentsForRender), NOT the flaky client `experiment_exposure` event.
 *   2. A CONVERSION = an `orders` row whose `session_id` is one of those stamped
 *      sessions — an in-session purchase, no 14-day anonymous_id window. The order
 *      supplies authoritative revenue, `subscription_id` (sub-attach), refund status.
 *
 * IDEMPOTENT: every refresh recomputes each variant's rollup from source and
 * OVERWRITES the columns — a re-run never double-counts. The posterior is DERIVED from
 * the rollup, never incremented.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { ExperimentRow, VariantRow } from "@/lib/storefront/experiments";

/** Retained for the LTV-metrics module ([[storefront-ltv-metrics]]) which mirrors the
 *  old consider→buy lag. Session-stamped attribution itself is in-session (no window). */
export const DEFAULT_WINDOW_DAYS = 14;

/** Placeholder estimated incremental sub-LTV bonus (cents) a subscription
 *  conversion contributes to the predicted-LTV proxy ON TOP of its order revenue. */
export const EST_SUB_LTV_CENTS = 12000;

type Admin = ReturnType<typeof createAdminClient>;

/** One element of storefront_sessions.experiment_assignments. */
interface SessionAssignment {
  experiment_id: string;
  variant_id: string;
  arm: "control" | "variant" | "holdout";
  assigned_at?: string;
  surface?: string | null;
}

export interface VariantRollupResult {
  experiment_id: string;
  variant_id: string;
  is_control: boolean;
  sessions: number;
  conversions: number;
  sub_attach: number;
  revenue_cents: number;
  ltv_proxy_cents: number;
  /** Refunded attributed orders — the Phase-5 refund-spike signal. */
  refunds: number;
  /** Derived Beta-Bernoulli posterior over the conversion proxy. */
  alpha: number;
  beta: number;
}

export interface AttributionRefreshResult {
  experiments: number;
  variants: number;
  rollups: VariantRollupResult[];
}

const REFUNDED = new Set(["REFUNDED", "refunded", "partially_refunded", "PARTIALLY_REFUNDED"]);

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const PAGE = 1000;
const MAX_PAGES = 100; // safety cap (100k rows) — logs if hit

/**
 * Page through the sessions stamped to one experiment (excluding internal/bot — the
 * report-layer exclusion). Uses the dedicated `.contains` (jsonb @>) filter, which
 * supabase-js serializes safely, ordered by created_at,id for stable paging.
 */
async function fetchStampedSessions(
  admin: Admin,
  workspaceId: string,
  experimentId: string,
): Promise<Array<{ id: string; experiment_assignments: SessionAssignment[] }>> {
  const rows: Array<{ id: string; experiment_assignments: SessionAssignment[] }> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await admin
      .from("storefront_sessions")
      .select("id, experiment_assignments")
      .eq("workspace_id", workspaceId)
      .eq("is_internal", false)
      .eq("is_bot", false)
      .contains("experiment_assignments", JSON.stringify([{ experiment_id: experimentId }]))
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const batch =
      (data as unknown as Array<{ id: string; experiment_assignments: SessionAssignment[] | null }>) || [];
    for (const r of batch) rows.push({ id: r.id, experiment_assignments: r.experiment_assignments || [] });
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) {
      console.warn(`[storefront-experiment-attribution] stamped-sessions hit ${MAX_PAGES}-page cap for exp=${experimentId}`);
    }
  }
  return rows;
}

/**
 * Recompute + persist attribution rollups for every running/promoted experiment in
 * a workspace (or a single experiment via opts.experimentId). Returns the per-variant
 * rollups so the bandit ([[storefront-bandit]]) can act on them without re-querying.
 */
export async function refreshExperimentAttribution(opts: {
  workspaceId: string;
  experimentId?: string;
  /** @deprecated session-stamped attribution is in-session; retained for API compat. */
  windowDays?: number;
  now?: Date;
}): Promise<AttributionRefreshResult> {
  const admin = createAdminClient();
  const now = opts.now ?? new Date();
  void opts.windowDays;

  // 1. Active experiments + their variants.
  let expQuery = admin
    .from("storefront_experiments")
    .select("id, workspace_id, product_id, lander_type, audience, lever, status, holdout_pct, promoted_variant_id")
    .eq("workspace_id", opts.workspaceId)
    .in("status", ["running", "promoted"]);
  if (opts.experimentId) expQuery = expQuery.eq("id", opts.experimentId);
  const { data: experiments } = await expQuery;
  if (!experiments?.length) return { experiments: 0, variants: 0, rollups: [] };

  const { data: variantsData } = await admin
    .from("storefront_experiment_variants")
    .select("id, experiment_id, is_control")
    .in(
      "experiment_id",
      experiments.map((e) => e.id),
    );
  const variants = (variantsData as Pick<VariantRow, "id" | "experiment_id" | "is_control">[]) || [];
  if (!variants.length) return { experiments: experiments.length, variants: 0, rollups: [] };

  const variantById = new Map(variants.map((v) => [v.id, v]));

  // 2. Stamped sessions → per-variant session sets (excluding internal/bot). A session
  //    is stamped to at most one arm per experiment, but may span multiple experiments.
  const sessionsByVariant = new Map<string, Set<string>>();
  const allSessionIds = new Set<string>();
  for (const exp of experiments) {
    const sessions = await fetchStampedSessions(admin, opts.workspaceId, exp.id);
    for (const s of sessions) {
      for (const a of s.experiment_assignments) {
        if (a.experiment_id !== exp.id || !variantById.has(a.variant_id)) continue;
        const set = sessionsByVariant.get(a.variant_id) ?? new Set<string>();
        set.add(s.id);
        sessionsByVariant.set(a.variant_id, set);
        allSessionIds.add(s.id);
      }
    }
  }

  // 3. Orders whose session_id is one of the stamped sessions = the in-session
  //    conversions. Earliest order per session wins (a session counts once).
  type OrderRow = { session_id: string; total_cents: number; subscription_id: string | null; financial_status: string | null; created_at: string };
  const orderBySession = new Map<string, OrderRow>();
  for (const ids of chunk([...allSessionIds], 200)) {
    if (!ids.length) continue;
    const { data } = await admin
      .from("orders")
      .select("session_id, total_cents, subscription_id, financial_status, created_at")
      .eq("workspace_id", opts.workspaceId)
      .in("session_id", ids);
    for (const o of (data as Array<{ session_id: string | null; total_cents: number | null; subscription_id: string | null; financial_status: string | null; created_at: string }>) || []) {
      if (!o.session_id) continue;
      const prev = orderBySession.get(o.session_id);
      if (!prev || new Date(o.created_at).getTime() < new Date(prev.created_at).getTime()) {
        orderBySession.set(o.session_id, {
          session_id: o.session_id,
          total_cents: o.total_cents ?? 0,
          subscription_id: o.subscription_id,
          financial_status: o.financial_status,
          created_at: o.created_at,
        });
      }
    }
  }

  // 4. Roll up per variant.
  const rollups: VariantRollupResult[] = [];
  for (const v of variants) {
    const sset = sessionsByVariant.get(v.id) ?? new Set<string>();
    const sessions = sset.size;
    let conversions = 0;
    let subAttach = 0;
    let revenueCents = 0;
    let oneTimeRevenue = 0;
    let refunds = 0;
    for (const sid of sset) {
      const order = orderBySession.get(sid);
      if (!order) continue;
      conversions += 1;
      revenueCents += order.total_cents;
      if (order.subscription_id) subAttach += 1;
      else oneTimeRevenue += order.total_cents;
      if (order.financial_status && REFUNDED.has(order.financial_status)) refunds += 1;
    }
    const ltvProxyCents = oneTimeRevenue + subAttach * EST_SUB_LTV_CENTS;
    const alpha = 1 + conversions;
    const beta = 1 + Math.max(0, sessions - conversions);
    rollups.push({
      experiment_id: v.experiment_id,
      variant_id: v.id,
      is_control: v.is_control,
      sessions,
      conversions,
      sub_attach: subAttach,
      revenue_cents: revenueCents,
      ltv_proxy_cents: ltvProxyCents,
      refunds,
      alpha,
      beta,
    });
  }

  // 5. Persist (overwrite — idempotent).
  const stamp = now.toISOString();
  for (const r of rollups) {
    await admin
      .from("storefront_experiment_variants")
      .update({
        sessions: r.sessions,
        conversions: r.conversions,
        sub_attach: r.sub_attach,
        revenue_cents: r.revenue_cents,
        ltv_proxy_cents: r.ltv_proxy_cents,
        alpha: r.alpha,
        beta: r.beta,
        reward_sum: r.ltv_proxy_cents,
        n: r.sessions,
        last_rolled_up_at: stamp,
        updated_at: stamp,
      })
      .eq("id", r.variant_id);
  }

  return { experiments: experiments.length, variants: variants.length, rollups };
}

export type { ExperimentRow };
