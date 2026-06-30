/**
 * Hierarchical storefront funnel — the single source of truth for both the
 * Growth Director (Max) and the funnel-page card. ONE computation, two
 * consumers, so the number Max acts on and the number Dylan sees are identical.
 *
 * The tree (per product, variable depth):
 *
 *   Amazing Coffee                ← PRODUCT  (rollup of PDP + All Landers)
 *   ├── Product Page (bare PDP)       ← leaf
 *   └── All Landers                   ← rollup of every variant
 *       ├── Advertorial                   ← VARIANT (rollup of its angles)
 *       │   ├── secret-reveal …               ← angle (leaf — atomic)
 *       │   └── …
 *       ├── Listicle / Reasons            ← VARIANT
 *       └── Before/After                  ← VARIANT
 *
 * ── Bucketing keys (URL-param-first; locked 2026-06-30) ──────────────────
 *   - PRODUCT  ← the `products.handle` segment of `landing_url`'s path
 *               (universal — works for PDP and lander alike; first-touch).
 *   - PDP vs LANDER ← presence of the `?variant=` param in `landing_url`.
 *               Absent = bare PDP; present = a lander. Keyed on the PARAM,
 *               NOT `advertorial_page_id`: the param captures intent ("this
 *               URL was built as a lander") and survives angle-resolution
 *               misses that would otherwise leak a lander into PDP. The
 *               `advertorial_pages` join is demoted to pure enrichment
 *               (headline / hero_kind for display), never bucketing.
 *   - VARIANT  ← the VALUE of the `?variant=` param (reasons|advertorial|
 *               beforeafter|…). No join, resolution-independent.
 *   - ANGLE    ← the VALUE of the `?angle=` param. The atomic leaf.
 *
 * ── Visit definition ──────────────────────────────────────────────────────
 *   Top-of-funnel "visit" = a session that fired ANY storefront event in the
 *   window (the page loaded), NOT strictly a `pdp_view` event. pdp_view's
 *   first-flush delivery drops ~17% (pixel reliability), so counting it would
 *   undercount visits and inflate every rate. Deeper steps (engaged / pack /
 *   checkout / order) stay event-based. This intentionally makes the visit
 *   count EXCEED the legacy funnel's pdp_view top line — by the dropped ~17%.
 *
 * ── Rollup math ──────────────────────────────────────────────────────────
 *   Each session lands on exactly one leaf (first-touch), so leaf session
 *   sets are MUTUALLY EXCLUSIVE — counts roll up by summation with no
 *   double-counting. Rates are RECOMPUTED at every node from the summed
 *   counts; we never average the children's percentages.
 *
 * ── Real-traffic exclusion ────────────────────────────────────────────────
 *   Mirrors the legacy funnel route: drop is_internal, is_bot, and sessions
 *   stitched to an internal customer. So the tree reflects real shoppers only
 *   and `grandTotal` reconciles with the existing funnel's top line.
 *
 * Read-only. Takes UTC instants (the caller owns Central-time boundary math),
 * so it runs unchanged in a Next.js route handler AND in Max's agent runtime.
 */
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** event_type → funnel step key. Pack-selected ↔ checkout-started are 1:1 by
 *  design (the customize page is optional), so checkout_view is the reliable
 *  "reached checkout" signal. */
// Deeper-step events → funnel step key. `visit` is NOT derived from pdp_view
// (it's forced for every session in the event-window universe — see below);
// pdp_view is left out of this map intentionally.
const STEP_OF_EVENT: Record<string, keyof FunnelStepCounts> = {
  pdp_engaged: "engaged",
  pack_selected: "pack_selected",
  checkout_view: "checkout_started",
  order_placed: "order_placed",
  add_to_cart: "add_to_cart",
};

const VARIANT_LABEL: Record<string, string> = {
  reasons: "Listicle / Reasons",
  advertorial: "Advertorial",
  beforeafter: "Before/After",
};

/** Sentinel slice value for sessions with no `utm_source` (direct / organic).
 *  Round-trips through the route + dropdown so "Direct / none" is selectable. */
export const DIRECT_UTM = "(direct)";

export interface FunnelStepCounts {
  visit: number;
  engaged: number;
  pack_selected: number;
  checkout_started: number;
  order_placed: number;
  add_to_cart: number;
}

export interface FunnelNodeMetrics extends FunnelStepCounts {
  /** engaged / visit */
  engagement_rate: number;
  /** order_placed / visit — the overall PDP→order CVR */
  conversion_rate: number;
  /** add_to_cart / visit */
  atc_rate: number;
}

export type FunnelNodeLevel = "product" | "pdp" | "all_landers" | "variant" | "angle";

export interface FunnelNode {
  level: FunnelNodeLevel;
  /** Stable key within its parent: handle | "pdp" | "all_landers" | variant value | angle slug. */
  key: string;
  label: string;
  metrics: FunnelNodeMetrics;
  children?: FunnelNode[];
  enrichment?: {
    headline?: string | null;
    hero_kind?: string | null;
    advertorial_page_id?: string | null;
    product_handle?: string | null;
    product_title?: string | null;
  };
}

export interface FunnelTreeResult {
  startIso: string;
  endIso: string;
  /** The product slice applied (null = all products). */
  productHandle: string | null;
  /** The traffic-source slice applied (null = all sources; DIRECT_UTM = direct). */
  utmSource: string | null;
  /** Forest of product nodes (one when sliced). */
  products: FunnelNode[];
  /** Sessions whose landing path matched no known product handle (e.g. landed
   *  on /checkout). Surfaced separately, never folded into a product — but
   *  INCLUDED in grandTotal so it reconciles with the legacy funnel. */
  unattributedEntry: FunnelNode | null;
  /** All included sessions combined (products + unattributed). Reconciles with
   *  the legacy funnel route's top line for the same window. */
  grandTotal: FunnelNodeMetrics;
}

// ── internal mutable accumulators ──────────────────────────────────────────
function zero(): FunnelStepCounts {
  return { visit: 0, engaged: 0, pack_selected: 0, checkout_started: 0, order_placed: 0, add_to_cart: 0 };
}
function addInto(target: FunnelStepCounts, reached: Set<keyof FunnelStepCounts>) {
  for (const step of reached) target[step] += 1;
}
function sumInto(target: FunnelStepCounts, src: FunnelStepCounts) {
  target.visit += src.visit;
  target.engaged += src.engaged;
  target.pack_selected += src.pack_selected;
  target.checkout_started += src.checkout_started;
  target.order_placed += src.order_placed;
  target.add_to_cart += src.add_to_cart;
}
function rate(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 1000 : 0;
}
function metricsOf(c: FunnelStepCounts): FunnelNodeMetrics {
  return {
    ...c,
    engagement_rate: rate(c.engaged, c.visit),
    conversion_rate: rate(c.order_placed, c.visit),
    atc_rate: rate(c.add_to_cart, c.visit),
  };
}

/** Parse a first-touch landing_url into its path segments + the variant/angle
 *  params. Tolerates absolute, relative, and malformed URLs. */
export function parseLanding(landingUrl: string | null): {
  segments: string[];
  variant: string | null;
  angle: string | null;
} {
  if (!landingUrl) return { segments: [], variant: null, angle: null };
  let path = landingUrl;
  let params: URLSearchParams;
  try {
    const u = new URL(landingUrl);
    path = u.pathname;
    params = u.searchParams;
  } catch {
    const q = landingUrl.indexOf("?");
    path = q >= 0 ? landingUrl.slice(0, q) : landingUrl;
    params = new URLSearchParams(q >= 0 ? landingUrl.slice(q + 1) : "");
  }
  const segments = path.split("/").filter(Boolean).map((s) => decodeURIComponent(s).toLowerCase());
  const variant = (params.get("variant") || "").trim().toLowerCase() || null;
  const angle = (params.get("angle") || "").trim() || null;
  return { segments, variant, angle };
}

/** First path segment that matches a known product handle, else null. Robust to
 *  path shape (`/amazing-coffee`, `/store/superfoods/amazing-coffee`, …). */
function resolveHandle(segments: string[], handleSet: Set<string>): string | null {
  for (const seg of segments) if (handleSet.has(seg)) return seg;
  return null;
}

async function fetchAllRows<T>(
  makeQuery: () => { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }> },
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1);
    if (error) break;
    const rows = data || [];
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

export interface FunnelTreeArgs {
  admin: Admin;
  workspaceId: string;
  startIso: string;
  endIso: string;
  /** Optional product slice — a `products.handle`. Omit/null for All products. */
  productHandle?: string | null;
  /** Optional traffic-source slice — a `utm_source` value, or DIRECT_UTM for
   *  sessions with no utm_source. Omit/null for All sources. Composes with
   *  productHandle (a session must pass both). */
  utmSource?: string | null;
}

/**
 * Build the hierarchical funnel tree for a window, optionally sliced to one
 * product. Mirrors the legacy funnel's event-window + real-traffic semantics,
 * so the All-products grandTotal reconciles with the existing funnel route.
 */
export async function computeFunnelTree(args: FunnelTreeArgs): Promise<FunnelTreeResult> {
  const { admin, workspaceId, startIso, endIso } = args;
  const slice = args.productHandle ? args.productHandle.toLowerCase() : null;
  const utmWanted = args.utmSource && args.utmSource.trim() ? args.utmSource.trim().toLowerCase() : null;

  // ── reference data ──────────────────────────────────────────────────────
  const [{ data: productRows }, { data: internalCustomerRows }, { data: pageRows }] = await Promise.all([
    admin.from("products").select("handle, title").eq("workspace_id", workspaceId),
    admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("is_internal", true),
    admin.from("advertorial_pages").select("id, slug, variant, headline, hero_kind").eq("workspace_id", workspaceId),
  ]);
  const handleSet = new Set<string>((productRows || []).map((p) => String(p.handle).toLowerCase()));
  const handleTitle = new Map<string, string>((productRows || []).map((p) => [String(p.handle).toLowerCase(), p.title as string]));
  const internalCustomerIds = new Set<string>((internalCustomerRows || []).map((c) => c.id as string));
  // angle slug → enrichment (headline/hero_kind/page id). Enrichment only.
  const pageBySlug = new Map<string, { id: string; headline: string | null; hero_kind: string | null }>();
  for (const p of pageRows || []) {
    pageBySlug.set(String(p.slug), { id: p.id as string, headline: (p.headline as string) ?? null, hero_kind: (p.hero_kind as string) ?? null });
  }

  // ── ALL events in window → visit universe + per-session reached steps ─────
  // "Visit" = a session that fired ANY storefront event in the window (the page
  // loaded), NOT strictly a `pdp_view` event. pdp_view's first-flush delivery
  // drops ~17% of the time (see specs/pixel-pdp-view-delivery), which would
  // silently undercount top-of-funnel and INFLATE every downstream rate. A
  // session's mere presence in the event log is the reliable visit signal.
  const eventRows = await fetchAllRows<{ event_type: string; session_id: string }>(() =>
    admin
      .from("storefront_events")
      .select("event_type, session_id")
      .eq("workspace_id", workspaceId)
      .gte("created_at", startIso)
      .lte("created_at", endIso)
      .order("id", { ascending: true }),
  );
  const visitSessions = new Set<string>();
  const reachedBySession = new Map<string, Set<keyof FunnelStepCounts>>();
  for (const e of eventRows) {
    visitSessions.add(e.session_id);
    const step = STEP_OF_EVENT[e.event_type];
    if (!step) continue;
    let set = reachedBySession.get(e.session_id);
    if (!set) { set = new Set(); reachedBySession.set(e.session_id, set); }
    set.add(step);
  }

  // ── fetch the visit-universe sessions (batched) ───────────────────────────
  const sessionIds = [...visitSessions];
  const sessionById = new Map<string, { landing_url: string | null; is_internal: boolean; is_bot: boolean; customer_id: string | null; utm_source: string | null }>();
  for (let i = 0; i < sessionIds.length; i += 300) {
    const chunk = sessionIds.slice(i, i + 300);
    const { data } = await admin
      .from("storefront_sessions")
      .select("id, landing_url, is_internal, is_bot, customer_id, utm_source")
      .in("id", chunk);
    for (const s of data || []) {
      sessionById.set(s.id as string, {
        landing_url: (s.landing_url as string) ?? null,
        is_internal: !!s.is_internal,
        is_bot: !!s.is_bot,
        customer_id: (s.customer_id as string) ?? null,
        utm_source: (s.utm_source as string) ?? null,
      });
    }
  }

  // ── bucket each real session into its leaf ────────────────────────────────
  type ProductAcc = { pdp: FunnelStepCounts; variants: Map<string, Map<string, FunnelStepCounts>> };
  const products = new Map<string, ProductAcc>();
  const unattributed = zero();
  let unattributedHasAny = false;

  const NO_ANGLE = "(no angle)";

  for (const sid of visitSessions) {
    const s = sessionById.get(sid);
    if (!s) continue; // session row missing — can't bucket
    if (s.is_internal || s.is_bot) continue;
    if (s.customer_id && internalCustomerIds.has(s.customer_id)) continue;

    // Traffic-source slice (composes with the product slice below).
    if (utmWanted) {
      if (utmWanted === DIRECT_UTM) { if (s.utm_source) continue; }
      else if ((s.utm_source || "").toLowerCase() !== utmWanted) continue;
    }

    // Every session in the universe loaded the page → always a visit. The deeper
    // steps come from the events it actually fired in the window.
    const reached = new Set<keyof FunnelStepCounts>(reachedBySession.get(sid));
    reached.add("visit");

    const { segments, variant, angle } = parseLanding(s.landing_url);
    const handle = resolveHandle(segments, handleSet);

    if (!handle) {
      addInto(unattributed, reached);
      unattributedHasAny = true;
      continue;
    }
    if (slice && handle !== slice) continue; // product slice filter

    let acc = products.get(handle);
    if (!acc) { acc = { pdp: zero(), variants: new Map() }; products.set(handle, acc); }

    if (!variant) {
      // no variant param → bare PDP leaf
      addInto(acc.pdp, reached);
    } else {
      let variantMap = acc.variants.get(variant);
      if (!variantMap) { variantMap = new Map(); acc.variants.set(variant, variantMap); }
      const angleKey = angle || NO_ANGLE;
      let leaf = variantMap.get(angleKey);
      if (!leaf) { leaf = zero(); variantMap.set(angleKey, leaf); }
      addInto(leaf, reached);
    }
  }

  // ── assemble tree with bottom-up rollups ──────────────────────────────────
  const productNodes: FunnelNode[] = [];
  const grand = zero();

  for (const [handle, acc] of products) {
    const productCounts = zero();

    // PDP leaf
    sumInto(productCounts, acc.pdp);
    const pdpNode: FunnelNode = {
      level: "pdp",
      key: "pdp",
      label: "Product Page (bare PDP)",
      metrics: metricsOf(acc.pdp),
      enrichment: { product_handle: handle, product_title: handleTitle.get(handle) ?? null },
    };

    // variants → angles
    const landersCounts = zero();
    const variantNodes: FunnelNode[] = [];
    for (const [variant, angleMap] of acc.variants) {
      const variantCounts = zero();
      const angleNodes: FunnelNode[] = [];
      for (const [angleKey, leaf] of angleMap) {
        sumInto(variantCounts, leaf);
        const enr = angleKey !== NO_ANGLE ? pageBySlug.get(angleKey) : undefined;
        angleNodes.push({
          level: "angle",
          key: angleKey,
          label: enr?.headline || angleKey,
          metrics: metricsOf(leaf),
          enrichment: {
            headline: enr?.headline ?? null,
            hero_kind: enr?.hero_kind ?? null,
            advertorial_page_id: enr?.id ?? null,
            product_handle: handle,
            product_title: handleTitle.get(handle) ?? null,
          },
        });
      }
      angleNodes.sort((a, b) => b.metrics.visit - a.metrics.visit);
      sumInto(landersCounts, variantCounts);
      variantNodes.push({
        level: "variant",
        key: variant,
        label: VARIANT_LABEL[variant] || variant,
        metrics: metricsOf(variantCounts),
        children: angleNodes,
      });
    }
    variantNodes.sort((a, b) => b.metrics.visit - a.metrics.visit);
    sumInto(productCounts, landersCounts);

    const children: FunnelNode[] = [pdpNode];
    if (variantNodes.length > 0) {
      children.push({
        level: "all_landers",
        key: "all_landers",
        label: "All Landers",
        metrics: metricsOf(landersCounts),
        children: variantNodes,
      });
    }

    sumInto(grand, productCounts);
    productNodes.push({
      level: "product",
      key: handle,
      label: handleTitle.get(handle) ?? handle,
      metrics: metricsOf(productCounts),
      children,
      enrichment: { product_handle: handle, product_title: handleTitle.get(handle) ?? null },
    });
  }

  productNodes.sort((a, b) => b.metrics.visit - a.metrics.visit);

  let unattributedEntry: FunnelNode | null = null;
  if (unattributedHasAny && !slice) {
    sumInto(grand, unattributed);
    unattributedEntry = {
      level: "product",
      key: "(unattributed)",
      label: "Unattributed entry (non-product landing)",
      metrics: metricsOf(unattributed),
    };
  }

  return {
    startIso,
    endIso,
    productHandle: slice,
    utmSource: utmWanted,
    products: productNodes,
    unattributedEntry,
    grandTotal: metricsOf(grand),
  };
}

/**
 * Lightweight product list for the funnel-page slice dropdown: products that
 * actually have storefront sessions in the window (resolution-based, so dead
 * SKUs never appear), ordered by session volume. Self-pruning + dynamic.
 */
export async function listFunnelProducts(args: {
  admin: Admin;
  workspaceId: string;
  startIso: string;
  endIso: string;
}): Promise<Array<{ handle: string; title: string; sessions: number }>> {
  const { admin, workspaceId, startIso, endIso } = args;
  const { data: productRows } = await admin
    .from("products").select("handle, title").eq("workspace_id", workspaceId);
  const handleSet = new Set<string>((productRows || []).map((p) => String(p.handle).toLowerCase()));
  const handleTitle = new Map<string, string>((productRows || []).map((p) => [String(p.handle).toLowerCase(), p.title as string]));

  const sessions = await fetchAllRows<{ landing_url: string | null }>(() =>
    admin
      .from("storefront_sessions")
      .select("landing_url, last_seen_at")
      .eq("workspace_id", workspaceId)
      .eq("is_internal", false)
      .eq("is_bot", false)
      .gte("last_seen_at", startIso)
      .lte("last_seen_at", endIso)
      .order("last_seen_at", { ascending: true }),
  );
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const { segments } = parseLanding(s.landing_url);
    const handle = resolveHandle(segments, handleSet);
    if (!handle) continue;
    counts.set(handle, (counts.get(handle) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([handle, sessions]) => ({ handle, title: handleTitle.get(handle) ?? handle, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}

/**
 * Traffic-source list for the funnel-page `utm_source` slice dropdown:
 * distinct utm_source values present in real sessions in the window, ordered by
 * volume. Sessions with no utm_source collapse into one DIRECT_UTM row. Dynamic
 * + self-pruning — new sources (or stray ones like `facebook`) appear on their own.
 */
export async function listUtmSources(args: {
  admin: Admin;
  workspaceId: string;
  startIso: string;
  endIso: string;
}): Promise<Array<{ source: string; label: string; sessions: number }>> {
  const { admin, workspaceId, startIso, endIso } = args;
  const rows = await fetchAllRows<{ utm_source: string | null }>(() =>
    admin
      .from("storefront_sessions")
      .select("utm_source, last_seen_at")
      .eq("workspace_id", workspaceId)
      .eq("is_internal", false)
      .eq("is_bot", false)
      .gte("last_seen_at", startIso)
      .lte("last_seen_at", endIso)
      .order("last_seen_at", { ascending: true }),
  );
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.utm_source && r.utm_source.trim() ? r.utm_source : DIRECT_UTM;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([source, sessions]) => ({ source, label: source === DIRECT_UTM ? "Direct / none" : source, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}
