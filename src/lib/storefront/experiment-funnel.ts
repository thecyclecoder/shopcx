/**
 * Per-arm funnel rollup for the storefront test detail page — Phase 1 of
 * docs/brain/specs/storefront-test-detail-page.md.
 *
 * The detail page ([[../dashboard/storefront__optimizer]]) shows every arm of an
 * experiment side by side with its full funnel. The numbers the BANDIT decides on
 * (sessions / conversions / sub-attach / revenue / LTV-proxy + the Beta-Bernoulli
 * posterior) are read straight off the persisted
 * [[storefront_experiment_variants]] rollup columns that
 * [[storefront-experiment-attribution]] writes — NO divergent math, so the page and
 * the promote/kill decision never disagree.
 *
 * On top of those, this module derives the three funnel rates the bandit does NOT
 * persist — engagement %, add-to-cart rate, lead rate — fresh from the append-only
 * [[storefront_events]] log, keyed off the SAME exposure spine the attribution lib
 * uses (an `experiment_exposure` event carries `meta.variant_id` + a `session_id`).
 * A session counts toward an arm's ATC / lead / engagement iff it was exposed to
 * that arm. Internal/bot exposures were already dropped at write time, so this never
 * counts team/crawler noise.
 *
 * Read-only: it never writes. The bandit's refresh ([[storefront-experiment-attribution]])
 * owns mutating the rollup columns.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { winProbabilityVsControl } from "@/lib/storefront/bandit";

type Admin = ReturnType<typeof createAdminClient>;

/** Engagement signal: an exposed session is "engaged" if it fired any chapter
 *  view/dwell or a scroll-depth beacon (the spec's "chapter dwell / scroll-depth
 *  share"). */
const ENGAGEMENT_EVENTS = ["chapter_view", "chapter_dwell", "scroll_depth"] as const;

/** The persisted rollup columns the bandit decides on — read, never recomputed. */
export interface VariantRollupRow {
  id: string;
  experiment_id: string;
  label: string;
  is_control: boolean;
  sessions: number;
  conversions: number;
  sub_attach: number;
  revenue_cents: number;
  ltv_proxy_cents: number;
  alpha: number;
  beta: number;
}

export interface ArmFunnel {
  variant_id: string;
  label: string;
  is_control: boolean;
  /** Exposed sessions (the bandit's `sessions`, from the persisted rollup). */
  sessions: number;
  // Event-derived session counts (from storefront_events, keyed on the exposure spine).
  engaged_sessions: number;
  atc_sessions: number;
  lead_sessions: number;
  // Bandit-source outcome counts (persisted rollup columns).
  conversions: number;
  sub_attach: number;
  revenue_cents: number;
  ltv_proxy_cents: number;
  // Derived per-visitor rates / values.
  engagement_rate: number;
  atc_rate: number;
  lead_rate: number;
  conversion_rate: number;
  sub_attach_rate: number;
  revenue_per_visitor_cents: number;
  ltv_per_visitor_cents: number;
  // Posterior + win-probability vs control (null on the control arm itself).
  alpha: number;
  beta: number;
  win_prob: number | null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const PAGE = 1000;
const MAX_PAGES = 100;

/** Page through `experiment_exposure` events for the workspace (1000-row windows). */
async function fetchExposures(
  admin: Admin,
  workspaceId: string,
): Promise<Array<{ session_id: string | null; meta: Record<string, unknown> }>> {
  const rows: Array<{ session_id: string | null; meta: Record<string, unknown> }> = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data } = await admin
      .from("storefront_events")
      .select("session_id, meta, created_at, id")
      .eq("workspace_id", workspaceId)
      .eq("event_type", "experiment_exposure")
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    const batch = (data as unknown as Array<{ session_id: string | null; meta: Record<string, unknown> }>) || [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  return rows;
}

function div(num: number, den: number): number {
  return den > 0 ? num / den : 0;
}

/**
 * Build the side-by-side per-arm funnel for one experiment. Pure read: outcome
 * counts come from the persisted rollups (bandit source of truth); engagement / ATC
 * / lead come from storefront_events on the same exposure spine.
 *
 * `draws` controls the Monte-Carlo win-probability precision (mirrors the bandit's
 * default 4000).
 */
export async function computeExperimentFunnel(opts: {
  admin: Admin;
  workspaceId: string;
  variants: VariantRollupRow[];
  draws?: number;
}): Promise<ArmFunnel[]> {
  const { admin, workspaceId, variants } = opts;
  if (!variants.length) return [];

  const variantIds = new Set(variants.map((v) => v.id));

  // 1. Exposure spine: map each exposed session_id → its variant. Sticky assignment
  //    means a session belongs to at most one arm of this experiment.
  const variantBySession = new Map<string, string>();
  const exposedSessionsByVariant = new Map<string, Set<string>>();
  for (const v of variants) exposedSessionsByVariant.set(v.id, new Set());

  const exposures = await fetchExposures(admin, workspaceId);
  for (const row of exposures) {
    const variantId = String(row.meta?.variant_id ?? "");
    if (!variantIds.has(variantId) || !row.session_id) continue;
    variantBySession.set(row.session_id, variantId);
    exposedSessionsByVariant.get(variantId)!.add(row.session_id);
  }

  // 2. Pull ATC / lead / engagement events for the exposed sessions only (bounded by
  //    the exposure set, not the whole event log).
  const sessionIds = [...variantBySession.keys()];
  const atcByVariant = new Map<string, Set<string>>();
  const leadByVariant = new Map<string, Set<string>>();
  const engagedByVariant = new Map<string, Set<string>>();
  for (const v of variants) {
    atcByVariant.set(v.id, new Set());
    leadByVariant.set(v.id, new Set());
    engagedByVariant.set(v.id, new Set());
  }

  const FUNNEL_EVENTS = ["add_to_cart", "lead_captured", ...ENGAGEMENT_EVENTS];
  for (const ids of chunk(sessionIds, 200)) {
    if (!ids.length) continue;
    const { data } = await admin
      .from("storefront_events")
      .select("session_id, event_type")
      .eq("workspace_id", workspaceId)
      .in("event_type", FUNNEL_EVENTS)
      .in("session_id", ids);
    for (const row of (data as Array<{ session_id: string | null; event_type: string }>) || []) {
      if (!row.session_id) continue;
      const variantId = variantBySession.get(row.session_id);
      if (!variantId) continue;
      if (row.event_type === "add_to_cart") atcByVariant.get(variantId)!.add(row.session_id);
      else if (row.event_type === "lead_captured") leadByVariant.get(variantId)!.add(row.session_id);
      else engagedByVariant.get(variantId)!.add(row.session_id);
    }
  }

  // 3. Assemble each arm. `sessions` is the bandit's persisted exposed-session count
  //    (the denominator the bandit's posterior uses), so every rate shares the
  //    bandit's denominator.
  const control = variants.find((v) => v.is_control) ?? null;
  return variants.map((v) => {
    const sessions = v.sessions;
    const engaged = engagedByVariant.get(v.id)!.size;
    const atc = atcByVariant.get(v.id)!.size;
    const lead = leadByVariant.get(v.id)!.size;
    const winProb =
      v.is_control || !control
        ? null
        : winProbabilityVsControl(
            { alpha: v.alpha, beta: v.beta },
            { alpha: control.alpha, beta: control.beta },
            opts.draws ?? 4000,
          );
    return {
      variant_id: v.id,
      label: v.label,
      is_control: v.is_control,
      sessions,
      engaged_sessions: engaged,
      atc_sessions: atc,
      lead_sessions: lead,
      conversions: v.conversions,
      sub_attach: v.sub_attach,
      revenue_cents: v.revenue_cents,
      ltv_proxy_cents: v.ltv_proxy_cents,
      engagement_rate: div(engaged, sessions),
      atc_rate: div(atc, sessions),
      lead_rate: div(lead, sessions),
      conversion_rate: div(v.conversions, sessions),
      sub_attach_rate: div(v.sub_attach, sessions),
      revenue_per_visitor_cents: div(v.revenue_cents, sessions),
      ltv_per_visitor_cents: div(v.ltv_proxy_cents, sessions),
      alpha: v.alpha,
      beta: v.beta,
      win_prob: winProb,
    };
  });
}
