/**
 * Storefront experiment outcome attribution — Phase 3 of the storefront experiment
 * + bandit framework (docs/brain/specs/storefront-experiment-bandit-framework.md).
 *
 * Joins exposure → outcome per variant across the delayed-purchase window and
 * persists per-variant rollups (sessions, conversions, sub-attach, revenue,
 * LTV-proxy) + the Thompson-sampling posterior onto
 * [[storefront_experiment_variants]].
 *
 * Attribution spine — entirely session/identity-keyed off the append-only
 * [[storefront_events]] log, so it never re-parses URLs and never needs
 * orders.anonymous_id (which doesn't exist):
 *   1. `experiment_exposure` events → per variant_id, the set of exposed sessions
 *      keyed by `anonymous_id` with their FIRST-exposure timestamp.
 *   2. `order_placed` events (same session, carry meta.order_id/total_cents) within
 *      the delayed-purchase window AFTER first exposure → an attributed conversion.
 *   3. The orders table (by meta.order_id) supplies authoritative revenue,
 *      `subscription_id` (sub-attach), and refund status (Phase 5 refund-spike).
 *
 * IDEMPOTENT: every refresh recomputes each variant's rollup from source and
 * OVERWRITES the columns — a re-run never double-counts (the
 * [[../specs/storefront-iteration-engine]] Phase 3 discipline). The posterior is
 * DERIVED from the rollup, never incremented.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { ExperimentRow, VariantRow } from "@/lib/storefront/experiments";

/** Default consider→buy lag: an order attributes if it lands within this many days
 *  of first exposure. The cold-50+ lander cohort buys with a multi-day lag. */
export const DEFAULT_WINDOW_DAYS = 14;

/** Placeholder estimated incremental sub-LTV bonus (cents) a subscription
 *  conversion contributes to the predicted-LTV proxy ON TOP of its order revenue.
 *  Sub-LTV ≫ one-time, so this steers the bandit toward subscribers. M3's
 *  reconciler RECALIBRATES this weight against actual 4-month cohort LTV; this spec
 *  only records the raw proxy stream. */
export const EST_SUB_LTV_CENTS = 12000;

type Admin = ReturnType<typeof createAdminClient>;

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

/** Page through a query in 1000-row windows (Supabase's default cap), ordered by
 *  created_at then id for stable paging. */
async function fetchAllEvents(
  admin: Admin,
  workspaceId: string,
  eventType: string,
  select: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await admin
      .from("storefront_events")
      .select(select)
      .eq("workspace_id", workspaceId)
      .eq("event_type", eventType)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const batch = (data as unknown as Array<Record<string, unknown>>) || [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) {
      console.warn(`[storefront-experiment-attribution] ${eventType} hit ${MAX_PAGES}-page cap for ws=${workspaceId}`);
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
  windowDays?: number;
  now?: Date;
}): Promise<AttributionRefreshResult> {
  const admin = createAdminClient();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;

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

  const variantIds = variants.map((v) => v.id);
  const variantById = new Map(variants.map((v) => [v.id, v]));

  void variantIds; // retained for readability; variant membership is checked via variantById

  // 2. Exposure events. Filter to our variants in JS (the meta->>variant_id JSON
  //    filter is fragile across PostgREST versions; paging + a Set is robust).
  //    Keyed by anonymous_id (the sticky-assignment identity).
  type Exposure = { variantId: string; anon: string; sessionId: string; at: number };
  const exposures: Exposure[] = [];
  const exposureRows = await fetchAllEvents(admin, opts.workspaceId, "experiment_exposure", "session_id, anonymous_id, meta, created_at");
  for (const raw of exposureRows) {
    const row = raw as { session_id: string | null; anonymous_id: string | null; meta: Record<string, unknown>; created_at: string };
    const variantId = String(row.meta?.variant_id ?? "");
    if (!variantById.has(variantId) || !row.anonymous_id) continue;
    exposures.push({
      variantId,
      anon: row.anonymous_id,
      sessionId: row.session_id ?? "",
      at: new Date(row.created_at).getTime(),
    });
  }

  // Per variant: distinct exposed sessions + earliest exposure per anon.
  const firstExposureByVariantAnon = new Map<string, number>(); // `${variantId}|${anon}` → ms
  const sessionsByVariant = new Map<string, Set<string>>();
  const anonsByVariant = new Map<string, Set<string>>();
  for (const e of exposures) {
    const key = `${e.variantId}|${e.anon}`;
    const prev = firstExposureByVariantAnon.get(key);
    if (prev === undefined || e.at < prev) firstExposureByVariantAnon.set(key, e.at);
    if (e.sessionId) {
      const s = sessionsByVariant.get(e.variantId) ?? new Set();
      s.add(e.sessionId);
      sessionsByVariant.set(e.variantId, s);
    }
    const a = anonsByVariant.get(e.variantId) ?? new Set();
    a.add(e.anon);
    anonsByVariant.set(e.variantId, a);
  }

  // 3. order_placed events for all exposed anons (within window). Pull order ids.
  const allAnons = [...new Set(exposures.map((e) => e.anon))];
  type OrderEvent = { anon: string; orderId: string; at: number };
  const orderEvents: OrderEvent[] = [];
  for (const ids of chunk(allAnons, 200)) {
    if (!ids.length) continue;
    const { data } = await admin
      .from("storefront_events")
      .select("anonymous_id, meta, created_at")
      .eq("workspace_id", opts.workspaceId)
      .eq("event_type", "order_placed")
      .in("anonymous_id", ids);
    for (const row of (data as Array<{ anonymous_id: string | null; meta: Record<string, unknown>; created_at: string }>) || []) {
      const orderId = String(row.meta?.order_id ?? "");
      if (!row.anonymous_id || !orderId) continue;
      orderEvents.push({ anon: row.anonymous_id, orderId, at: new Date(row.created_at).getTime() });
    }
  }

  // 4. Look up the attributed orders (authoritative revenue / sub-attach / refunds).
  const orderIds = [...new Set(orderEvents.map((o) => o.orderId))];
  const orderById = new Map<string, { total_cents: number; subscription_id: string | null; financial_status: string | null }>();
  for (const ids of chunk(orderIds, 200)) {
    if (!ids.length) continue;
    const { data } = await admin
      .from("orders")
      .select("id, total_cents, subscription_id, financial_status")
      .in("id", ids);
    for (const o of (data as Array<{ id: string; total_cents: number | null; subscription_id: string | null; financial_status: string | null }>) || []) {
      orderById.set(o.id, {
        total_cents: o.total_cents ?? 0,
        subscription_id: o.subscription_id,
        financial_status: o.financial_status,
      });
    }
  }

  // 5. Roll up per variant. A converting anon counts once; first qualifying order wins.
  const rollups: VariantRollupResult[] = [];
  for (const v of variants) {
    const anons = anonsByVariant.get(v.id) ?? new Set();
    let conversions = 0;
    let subAttach = 0;
    let revenueCents = 0;
    let oneTimeRevenue = 0;
    let refunds = 0;
    for (const anon of anons) {
      const firstExposed = firstExposureByVariantAnon.get(`${v.id}|${anon}`);
      if (firstExposed === undefined) continue;
      // Earliest qualifying order for this anon within the delayed-purchase window.
      const candidate = orderEvents
        .filter((o) => o.anon === anon && o.at >= firstExposed && o.at - firstExposed <= windowMs)
        .sort((a, b) => a.at - b.at)[0];
      if (!candidate) continue;
      const order = orderById.get(candidate.orderId);
      if (!order) continue;
      conversions += 1;
      revenueCents += order.total_cents;
      const isSub = !!order.subscription_id;
      if (isSub) subAttach += 1;
      else oneTimeRevenue += order.total_cents;
      if (order.financial_status && REFUNDED.has(order.financial_status)) refunds += 1;
    }
    const sessions = (sessionsByVariant.get(v.id) ?? new Set()).size || anons.size;
    // Predicted-LTV proxy: one-time order revenue + an est-sub-LTV bonus per sub.
    const ltvProxyCents = oneTimeRevenue + subAttach * EST_SUB_LTV_CENTS;
    // Beta-Bernoulli posterior over the conversion proxy.
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

  // 6. Persist (overwrite — idempotent).
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
