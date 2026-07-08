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
 * ── Blog as a top-level entry bucket ──────────────────────────────────────
 *   A session whose first-touch landing_url path starts with `/blog` and does
 *   NOT resolve to a product handle lands in the synthetic top-level "Blog"
 *   node (same level as product nodes) — so blog→bounce vs blog→product is
 *   legible instead of getting lumped into "Unattributed entry". Blog events
 *   (`blog_view`, `blog_engaged`) are intentionally NOT in `STEP_OF_EVENT`, so
 *   they never increment any product's engaged/pack/etc; a blog session
 *   contributes only a Visit on the Blog node. Blog→product session flow is
 *   ALSO surfaced via the composing "Blog" referrer slice on product nodes.
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
import { getMonthlyChurn, type ChurnBasis } from "@/lib/ltv";
import { winProbabilityVsControl } from "@/lib/storefront/bandit";

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

/**
 * Normalize a raw `referrer` into a stable PLATFORM/ORIGIN group — the referrer
 * slice key (the key IS the slice value; it round-trips through the dropdown).
 *
 * The blog lives on the STORE host (`shop.superfoodscompany.com/blog`), so it's
 * detected by the `/blog` PATH, not a host — and same-host non-blog referrers
 * are internal navigation, surfaced separately so they don't read as a source.
 */
export function referrerGroup(referrer: string | null): string {
  if (!referrer || !referrer.trim()) return "Direct / in-app";
  const raw = referrer.trim();
  // In-app webviews report the source app (com.facebook.katana, com.instagram.android, …)
  if (/^android-app:/i.test(raw) || /^ios-app:/i.test(raw)) {
    const a = raw.toLowerCase();
    if (a.includes("facebook")) return "Facebook";
    if (a.includes("instagram")) return "Instagram";
    if (a.includes("google")) return "Google Search";
    return "In-app";
  }
  let host = "";
  let path = "";
  try {
    const u = new URL(raw);
    host = u.hostname.toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    const m = raw.replace(/^https?:\/\//i, "");
    host = m.split("/")[0].toLowerCase();
    path = "/" + m.split("/").slice(1).join("/").toLowerCase();
  }
  if (host.endsWith("superfoodscompany.com")) {
    return path.startsWith("/blog") ? "Blog" : "Internal / on-site";
  }
  if (host.includes("facebook")) return "Facebook";
  if (host.includes("instagram")) return "Instagram";
  if (host.includes("google")) return "Google Search";
  if (host.includes("bing")) return "Bing";
  if (host.includes("tiktok")) return "TikTok";
  return host || "Direct / in-app";
}

// ── shared slice-match predicates (used by the tree AND the faceted options) ──
/** wanted=null → match all. DIRECT_UTM → sessions with no utm_source. */
function matchUtm(sUtm: string | null, wanted: string | null): boolean {
  if (!wanted) return true;
  if (wanted === DIRECT_UTM) return !sUtm;
  return (sUtm || "").toLowerCase() === wanted;
}
/** wanted=null → match all. Else compares against the session's referrerGroup. */
function matchRef(sRef: string | null, wanted: string | null): boolean {
  if (!wanted) return true;
  return referrerGroup(sRef) === wanted;
}

export interface FunnelStepCounts {
  visit: number;
  engaged: number;
  pack_selected: number;
  checkout_started: number;
  order_placed: number;
  add_to_cart: number;
  /** subscription orders (order with subscription_id) — for sub-attach rate */
  sub_orders: number;
  /** Σ order total_cents from this node's sessions (immediate revenue). */
  revenue_cents: number;
  /** Σ order total_cents × (sub ? 1/churn : 1) — predicted lifetime value. */
  ltv_cents: number;
}

export interface FunnelNodeMetrics extends FunnelStepCounts {
  /** engaged / visit */
  engagement_rate: number;
  /** pack_selected / visit */
  pack_rate: number;
  /** checkout_started / visit */
  checkout_rate: number;
  /** order_placed / visit — the overall PDP→order CVR */
  conversion_rate: number;
  /** add_to_cart / visit */
  atc_rate: number;
  /** sub_orders / order_placed — % of orders that attach a subscription */
  sub_attach_rate: number;
  /** revenue_cents / order_placed — average order value */
  aov_cents: number;
  /** revenue_cents / visit — immediate $ per visit */
  revenue_per_visit_cents: number;
  /** ltv_cents / visit — predicted LTV per visit (Max's north-star metric) */
  ltv_per_visit_cents: number;
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
  /** The referrer slice applied (null = all referrers; else a referrerGroup key). */
  referrer: string | null;
  /** Forest of product nodes (one when sliced). */
  products: FunnelNode[];
  /** Sessions whose landing path matched no known product handle (e.g. landed
   *  on /checkout). Surfaced separately, never folded into a product — but
   *  INCLUDED in grandTotal so it reconciles with the legacy funnel. */
  unattributedEntry: FunnelNode | null;
  /** Sessions whose first-touch landing_url path starts with /blog and does
   *  NOT resolve to a product handle — the blog itself. Same shape as
   *  unattributedEntry: a synthetic top-level node so blog→bounce vs blog→product
   *  is legible in the funnel (blog→product still surfaces via the "Blog"
   *  referrer slice on product nodes; this node is blog-as-entry-point).
   *  Visits count here; blog_view / blog_engaged never inflate any product's
   *  visit / pdp_view / engaged (blog events aren't in STEP_OF_EVENT). */
  blogEntry: FunnelNode | null;
  /** All included sessions combined (products + unattributed + blog). Reconciles
   *  with the legacy funnel route's top line for the same window. */
  grandTotal: FunnelNodeMetrics;
  /** The churn basis used for the LTV multiplier — surfaced for auditability
   *  (which window, what churn, the 1/churn sub multiplier applied). */
  ltvBasis: ChurnBasis;
}

// ── internal mutable accumulators ──────────────────────────────────────────
function zero(): FunnelStepCounts {
  return { visit: 0, engaged: 0, pack_selected: 0, checkout_started: 0, order_placed: 0, add_to_cart: 0, sub_orders: 0, revenue_cents: 0, ltv_cents: 0 };
}
function addInto(target: FunnelStepCounts, reached: Set<keyof FunnelStepCounts>) {
  for (const step of reached) target[step] += 1; // reached only ever holds step keys
}
function sumInto(target: FunnelStepCounts, src: FunnelStepCounts) {
  target.visit += src.visit;
  target.engaged += src.engaged;
  target.pack_selected += src.pack_selected;
  target.checkout_started += src.checkout_started;
  target.order_placed += src.order_placed;
  target.add_to_cart += src.add_to_cart;
  target.sub_orders += src.sub_orders;
  target.revenue_cents += src.revenue_cents;
  target.ltv_cents += src.ltv_cents;
}
function rate(n: number, d: number): number {
  return d > 0 ? Math.round((n / d) * 1000) / 1000 : 0;
}
function metricsOf(c: FunnelStepCounts): FunnelNodeMetrics {
  return {
    ...c,
    engagement_rate: rate(c.engaged, c.visit),
    pack_rate: rate(c.pack_selected, c.visit),
    checkout_rate: rate(c.checkout_started, c.visit),
    conversion_rate: rate(c.order_placed, c.visit),
    atc_rate: rate(c.add_to_cart, c.visit),
    sub_attach_rate: rate(c.sub_orders, c.order_placed),
    aov_cents: c.order_placed > 0 ? Math.round(c.revenue_cents / c.order_placed) : 0,
    revenue_per_visit_cents: c.visit > 0 ? Math.round(c.revenue_cents / c.visit) : 0,
    ltv_per_visit_cents: c.visit > 0 ? Math.round(c.ltv_cents / c.visit) : 0,
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

/** True when the landing path is a blog page (`/blog`, `/blog/{handle}`, or
 *  the workspace-prefixed forms `/store/{workspace}/blog[/…]`). Combined with a
 *  null product-handle check to yield the Blog top-level bucket — so the rare
 *  blog URL that ALSO happens to contain a product handle segment still routes
 *  to that product (preserves first-touch attribution + no double-counting). */
function isBlogLanding(segments: string[]): boolean {
  return segments.includes("blog");
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
  /** Churn window for the LTV sub-multiplier. Default 6 (trailing 6mo, responsive
   *  to retention). Pass null for all-history (ROAS margin-calc parity). */
  churnTrailingMonths?: number | null;
  /** Optional traffic-source slice — a `utm_source` value, or DIRECT_UTM for
   *  sessions with no utm_source. Omit/null for All sources. Composes with
   *  productHandle (a session must pass both). */
  utmSource?: string | null;
  /** Optional referrer slice — a `referrerGroup()` key (Facebook | Instagram |
   *  Google Search | Blog | Direct / in-app | …). Omit/null for All referrers.
   *  Composes with the other slices. */
  referrer?: string | null;
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
  const refWanted = args.referrer && args.referrer.trim() ? args.referrer.trim() : null;

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

  // ── LTV basis (churn) + per-session order revenue/ltv ─────────────────────
  // Sub multiplier = 1/churn (trailing window by default — responsive to retention).
  // Revenue comes from the `order_placed` EVENT (meta.total_cents) — it's reliably
  // session-linked (matches the ORDERS column). `orders.session_id` is sparse and
  // backfilled late, which zeroed fresh orders. The sub flag is joined order_id →
  // orders.subscription_id (best-effort: a not-yet-written order falls back to
  // one-time, so revenue still shows even before the order row exists).
  const ltvBasis = await getMonthlyChurn({ admin, workspaceId, trailingMonths: args.churnTrailingMonths });
  const subLO = ltvBasis.sub_lifetime_orders;
  const sessionIds = [...visitSessions];

  const orderEvents = await fetchAllRows<{ session_id: string; meta: Record<string, unknown> }>(() =>
    admin.from("storefront_events").select("session_id, meta, id")
      .eq("workspace_id", workspaceId).eq("event_type", "order_placed")
      .gte("created_at", startIso).lte("created_at", endIso).order("id", { ascending: true }),
  );
  const orderIds = [...new Set(orderEvents.map((e) => String((e.meta || {}).order_id || "")).filter(Boolean))];
  const subByOrderId = new Map<string, boolean>();
  for (let i = 0; i < orderIds.length; i += 300) {
    const { data } = await admin.from("orders").select("id, subscription_id").in("id", orderIds.slice(i, i + 300));
    for (const o of data || []) subByOrderId.set(o.id as string, !!o.subscription_id);
  }
  const orderBySession = new Map<string, { rev: number; ltv: number; subs: number }>();
  for (const e of orderEvents) {
    const m = e.meta || {};
    const cents = Number(m.total_cents) || 0;
    const oid = String(m.order_id || "");
    const isSub = oid ? (subByOrderId.get(oid) ?? false) : false;
    const cur = orderBySession.get(e.session_id) || { rev: 0, ltv: 0, subs: 0 };
    cur.rev += cents;
    cur.ltv += cents * (isSub ? subLO : 1);
    if (isSub) cur.subs += 1;
    orderBySession.set(e.session_id, cur);
  }
  const sessionById = new Map<string, { landing_url: string | null; is_internal: boolean; is_bot: boolean; customer_id: string | null; utm_source: string | null; referrer: string | null }>();
  for (let i = 0; i < sessionIds.length; i += 300) {
    const chunk = sessionIds.slice(i, i + 300);
    const { data } = await admin
      .from("storefront_sessions")
      .select("id, landing_url, is_internal, is_bot, customer_id, utm_source, referrer")
      .in("id", chunk);
    for (const s of data || []) {
      sessionById.set(s.id as string, {
        landing_url: (s.landing_url as string) ?? null,
        is_internal: !!s.is_internal,
        is_bot: !!s.is_bot,
        customer_id: (s.customer_id as string) ?? null,
        utm_source: (s.utm_source as string) ?? null,
        referrer: (s.referrer as string) ?? null,
      });
    }
  }

  // ── bucket each real session into its leaf ────────────────────────────────
  type ProductAcc = { pdp: FunnelStepCounts; variants: Map<string, Map<string, FunnelStepCounts>> };
  const products = new Map<string, ProductAcc>();
  const unattributed = zero();
  let unattributedHasAny = false;
  const blog = zero();
  let blogHasAny = false;

  const NO_ANGLE = "(no angle)";

  for (const sid of visitSessions) {
    const s = sessionById.get(sid);
    if (!s) continue; // session row missing — can't bucket
    if (s.is_internal || s.is_bot) continue;
    if (s.customer_id && internalCustomerIds.has(s.customer_id)) continue;

    // Traffic-source + referrer slices (compose with the product slice below).
    if (!matchUtm(s.utm_source, utmWanted)) continue;
    if (!matchRef(s.referrer, refWanted)) continue;

    // Every session in the universe loaded the page → always a visit. The deeper
    // steps come from the events it actually fired in the window.
    const reached = new Set<keyof FunnelStepCounts>(reachedBySession.get(sid));
    reached.add("visit");

    const { segments, variant, angle } = parseLanding(s.landing_url);
    const handle = resolveHandle(segments, handleSet);

    const ov = orderBySession.get(sid);
    const addRevLtv = (t: FunnelStepCounts) => { if (ov) { t.revenue_cents += ov.rev; t.ltv_cents += Math.round(ov.ltv); t.sub_orders += ov.subs; } };

    if (!handle) {
      // /blog landings that DIDN'T resolve to a product → first-class Blog bucket.
      // The rare blog URL whose path happens to contain a product-handle segment
      // still routes to that product above (preserves first-touch + no double-count).
      if (isBlogLanding(segments)) {
        addInto(blog, reached);
        addRevLtv(blog);
        blogHasAny = true;
      } else {
        addInto(unattributed, reached);
        addRevLtv(unattributed);
        unattributedHasAny = true;
      }
      continue;
    }
    if (slice && handle !== slice) continue; // product slice filter

    let acc = products.get(handle);
    if (!acc) { acc = { pdp: zero(), variants: new Map() }; products.set(handle, acc); }

    if (!variant) {
      // no variant param → bare PDP leaf
      addInto(acc.pdp, reached);
      addRevLtv(acc.pdp);
    } else {
      let variantMap = acc.variants.get(variant);
      if (!variantMap) { variantMap = new Map(); acc.variants.set(variant, variantMap); }
      const angleKey = angle || NO_ANGLE;
      let leaf = variantMap.get(angleKey);
      if (!leaf) { leaf = zero(); variantMap.set(angleKey, leaf); }
      addInto(leaf, reached);
      addRevLtv(leaf);
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

  let blogEntry: FunnelNode | null = null;
  if (blogHasAny && !slice) {
    sumInto(grand, blog);
    blogEntry = {
      level: "product",
      key: "(blog)",
      label: "Blog",
      metrics: metricsOf(blog),
    };
  }

  return {
    startIso,
    endIso,
    productHandle: slice,
    utmSource: utmWanted,
    referrer: refWanted,
    products: productNodes,
    unattributedEntry,
    blogEntry,
    grandTotal: metricsOf(grand),
    ltvBasis,
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

/**
 * Referrer list for the funnel-page referrer slice dropdown: real sessions in
 * the window grouped by `referrerGroup()` (Facebook / Instagram / Google Search
 * / Blog / Direct-in-app / …), ordered by volume. The group key IS the slice
 * value. Dynamic + self-pruning.
 */
export async function listReferrers(args: {
  admin: Admin;
  workspaceId: string;
  startIso: string;
  endIso: string;
}): Promise<Array<{ referrer: string; label: string; sessions: number }>> {
  const { admin, workspaceId, startIso, endIso } = args;
  const rows = await fetchAllRows<{ referrer: string | null }>(() =>
    admin
      .from("storefront_sessions")
      .select("referrer, last_seen_at")
      .eq("workspace_id", workspaceId)
      .eq("is_internal", false)
      .eq("is_bot", false)
      .gte("last_seen_at", startIso)
      .lte("last_seen_at", endIso)
      .order("last_seen_at", { ascending: true }),
  );
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = referrerGroup(r.referrer);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([referrer, sessions]) => ({ referrer, label: referrer, sessions }))
    .sort((a, b) => b.sessions - a.sessions);
}

/**
 * Faceted (chained) slice options for all three dropdowns in ONE pass. Each
 * list is cross-filtered by the OTHER selected slices but NOT its own — so
 * selecting Source=meta narrows the Referrer list to referrers SEEN in Meta
 * traffic, while the Source list itself still shows every source. "All" on a
 * slice (null) = no constraint from it. Computed over the wide dropdown window
 * so the lists stay stable across the selected date range.
 */
export async function listSliceOptions(args: {
  admin: Admin;
  workspaceId: string;
  startIso: string;
  endIso: string;
  product?: string | null;
  utmSource?: string | null;
  referrer?: string | null;
}): Promise<{
  productOptions: Array<{ handle: string; title: string; sessions: number }>;
  utmSourceOptions: Array<{ source: string; label: string; sessions: number }>;
  referrerOptions: Array<{ referrer: string; label: string; sessions: number }>;
}> {
  const { admin, workspaceId, startIso, endIso } = args;
  const product = args.product ? args.product.toLowerCase() : null;
  const utmWanted = args.utmSource && args.utmSource.trim() ? args.utmSource.trim().toLowerCase() : null;
  const refWanted = args.referrer && args.referrer.trim() ? args.referrer.trim() : null;

  const { data: productRows } = await admin
    .from("products").select("handle, title").eq("workspace_id", workspaceId);
  const handleSet = new Set<string>((productRows || []).map((p) => String(p.handle).toLowerCase()));
  const handleTitle = new Map<string, string>((productRows || []).map((p) => [String(p.handle).toLowerCase(), p.title as string]));

  const sessions = await fetchAllRows<{ landing_url: string | null; utm_source: string | null; referrer: string | null }>(() =>
    admin
      .from("storefront_sessions")
      .select("landing_url, utm_source, referrer, last_seen_at")
      .eq("workspace_id", workspaceId)
      .eq("is_internal", false)
      .eq("is_bot", false)
      .gte("last_seen_at", startIso)
      .lte("last_seen_at", endIso)
      .order("last_seen_at", { ascending: true }),
  );

  const productCounts = new Map<string, number>();
  const utmCounts = new Map<string, number>();
  const refCounts = new Map<string, number>();
  for (const s of sessions) {
    const { segments } = parseLanding(s.landing_url);
    const handle = resolveHandle(segments, handleSet);
    const okProduct = !product || handle === product;
    const okUtm = matchUtm(s.utm_source, utmWanted);
    const okRef = matchRef(s.referrer, refWanted);

    if (okUtm && okRef && handle) productCounts.set(handle, (productCounts.get(handle) || 0) + 1);
    if (okProduct && okRef) {
      const key = s.utm_source && s.utm_source.trim() ? s.utm_source : DIRECT_UTM;
      utmCounts.set(key, (utmCounts.get(key) || 0) + 1);
    }
    if (okProduct && okUtm) {
      const key = referrerGroup(s.referrer);
      refCounts.set(key, (refCounts.get(key) || 0) + 1);
    }
  }

  return {
    productOptions: [...productCounts.entries()]
      .map(([handle, sessions]) => ({ handle, title: handleTitle.get(handle) ?? handle, sessions }))
      .sort((a, b) => b.sessions - a.sessions),
    utmSourceOptions: [...utmCounts.entries()]
      .map(([source, sessions]) => ({ source, label: source === DIRECT_UTM ? "Direct / none" : source, sessions }))
      .sort((a, b) => b.sessions - a.sessions),
    referrerOptions: [...refCounts.entries()]
      .map(([referrer, sessions]) => ({ referrer, label: referrer, sessions }))
      .sort((a, b) => b.sessions - a.sessions),
  };
}

// ───────────────────────── Chapter diagnostics (the "why") ─────────────────────────
// Per-destination chapter sequence: WHERE the sequence leaks (reach by placement),
// WHICH chapter earns the pricing click (CTA-origin), attention (dwell), and the two
// levers — carry-to-pricing % and close % (pricing→pack). Attributes chapters by
// session→destination (landing variant/angle), so it is NOT blocked by the old
// chapter-performance data-section mislabel.

const PRICING_CHAPTERS = new Set(["pricing", "bundle-pricing"]);

// Which chapters each destination's page ACTUALLY renders — mirrors the section
// composition in `src/app/(storefront)/_lib/render-page.tsx` (KEEP IN SYNC). Used
// to drop cross-navigation noise: chapter events attribute to a session's landing
// destination, so a PDP-landing session that later hops to a lander would otherwise
// show that lander's hero/body in the PDP's list. We only display chapters the
// destination's own page renders.
const STANDARD_BODY = [
  "why-this-works", "mechanism", "ingredients", "endorsement", "upsell-chapter",
  "pricing", "bundle-pricing", "ugc", "comparison", "expect", "reviews", "faq",
  "final-cta", "brand-trust",
];
const DESTINATION_CHAPTERS: Record<string, Set<string>> = {
  pdp: new Set(["hero", "survey", ...STANDARD_BODY]),
  // The reasons listicle has its OWN curated body (not StandardChapters).
  reasons: new Set(["advertorial-hero", "reasons-listicle", "ingredients", "pricing", "reviews", "final-cta", "brand-trust"]),
  beforeafter: new Set(["beforeafter-hero", "hero", "testimonial-wall", ...STANDARD_BODY]),
  advertorial: new Set(["advertorial-hero", "advertorial-chapter", ...STANDARD_BODY]),
};

function round1(x: number): number { return Math.round(x * 10) / 10; }
function humanizeChapter(id: string): string {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
/** Destination-aware chapter label. The shared AdvertorialHero component emits
 *  `advertorial-hero` on BOTH the listicle and the advertorial — so the page
 *  variant is the only thing that distinguishes the listicle hero from the
 *  advertorial hero. */
function chapterLabel(chapter: string, destType: string): string {
  if (chapter === "advertorial-hero") return destType === "reasons" ? "Listicle Hero" : "Advertorial Hero";
  if (chapter === "beforeafter-hero") return "Before/After Hero";
  return humanizeChapter(chapter);
}

export interface ChapterRow {
  chapter: string;
  label: string;
  /** on-page placement (chapter_index) — the sequencing signal */
  index: number | null;
  reach: number;
  reach_pct: number;
  avg_dwell_ms: number;
  /** # pricing-jumps that fired FROM this chapter (persuasion attribution) */
  cta_origin: number;
  /** share of this destination's pricing jumps that originated here */
  cta_origin_pct: number;
  view_to_pricing_pct: number;
  view_to_pack_pct: number;
}

export interface FunnelStep {
  step: string;
  label: string;
  count: number;
  conv_from_prev_pct: number;
  conv_from_top_pct: number;
  drop_from_prev: number;
}
export interface ChapterDiagnosticsResult {
  destination: { key: string; label: string } | null;
  availableDestinations: Array<{ key: string; label: string; level: "pdp" | "variant" | "angle"; visits: number; parent?: string }>;
  summary: {
    visits: number;
    reached_pricing: number;
    carry_to_pricing_pct: number;
    packed: number;
    close_pct: number; // packed / reached_pricing
    jumped_to_pricing: number;
    scrolled_to_pricing: number;
  } | null;
  /** the 5-step funnel waterfall for the selected destination */
  funnelSteps: FunnelStep[];
  chapters: ChapterRow[];
}

export interface ChapterDiagnosticsArgs {
  admin: Admin;
  workspaceId: string;
  startIso: string;
  endIso: string;
  productHandle?: string | null;
  utmSource?: string | null;
  referrer?: string | null;
  /** 'pdp' | a variant value | an angle slug. Null → the top-volume destination. */
  destination?: string | null;
}

export async function computeChapterDiagnostics(args: ChapterDiagnosticsArgs): Promise<ChapterDiagnosticsResult> {
  const { admin, workspaceId, startIso, endIso } = args;
  const product = args.productHandle ? args.productHandle.toLowerCase() : null;
  const utmWanted = args.utmSource && args.utmSource.trim() ? args.utmSource.trim().toLowerCase() : null;
  const refWanted = args.referrer && args.referrer.trim() ? args.referrer.trim() : null;

  const [{ data: productRows }, { data: internalCustomerRows }, { data: pageRows }] = await Promise.all([
    admin.from("products").select("handle").eq("workspace_id", workspaceId),
    admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("is_internal", true),
    admin.from("advertorial_pages").select("slug, headline").eq("workspace_id", workspaceId),
  ]);
  const handleSet = new Set<string>((productRows || []).map((p) => String(p.handle).toLowerCase()));
  const internalCustomerIds = new Set<string>((internalCustomerRows || []).map((c) => c.id as string));
  const headlineBySlug = new Map<string, string>((pageRows || []).map((p) => [String(p.slug), (p.headline as string) || ""]));

  // visit universe = any event in window
  const eventRows = await fetchAllRows<{ session_id: string }>(() =>
    admin.from("storefront_events").select("session_id, id")
      .eq("workspace_id", workspaceId).gte("created_at", startIso).lte("created_at", endIso)
      .order("id", { ascending: true }),
  );
  const universe = new Set<string>(eventRows.map((e) => e.session_id));

  // classify each real + sliced session into its destination(s)
  const sessByDest = new Map<string, { variant: string | null; angle: string | null }>();
  const ids = [...universe];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await admin.from("storefront_sessions")
      .select("id, landing_url, is_internal, is_bot, customer_id, utm_source, referrer").in("id", ids.slice(i, i + 300));
    for (const s of data || []) {
      if (s.is_internal || s.is_bot) continue;
      if (s.customer_id && internalCustomerIds.has(s.customer_id as string)) continue;
      if (!matchUtm((s.utm_source as string) ?? null, utmWanted)) continue;
      if (!matchRef((s.referrer as string) ?? null, refWanted)) continue;
      const { segments, variant, angle } = parseLanding((s.landing_url as string) ?? null);
      const handle = resolveHandle(segments, handleSet);
      if (product && handle !== product) continue;
      sessByDest.set(s.id as string, { variant, angle });
    }
  }

  const destVisits = new Map<string, { level: "pdp" | "variant" | "angle"; visits: number }>();
  const angleParent = new Map<string, string>(); // angle slug → its variant (so angles nest under their variant)
  const bump = (key: string, level: "pdp" | "variant" | "angle") => {
    const cur = destVisits.get(key) || { level, visits: 0 }; cur.visits++; destVisits.set(key, cur);
  };
  for (const s of sessByDest.values()) {
    if (!s.variant) bump("pdp", "pdp");
    else { bump(s.variant, "variant"); if (s.angle) { bump(s.angle, "angle"); angleParent.set(s.angle, s.variant); } }
  }
  const labelFor = (key: string, level: "pdp" | "variant" | "angle") =>
    level === "pdp" ? "Product Page (bare PDP)" : level === "variant" ? (VARIANT_LABEL[key] || key) : (headlineBySlug.get(key) || key);
  const mk = (key: string, v: { level: "pdp" | "variant" | "angle"; visits: number }, parent?: string) =>
    ({ key, level: v.level, label: labelFor(key, v.level), visits: v.visits, parent });
  // Order: PDP, then each variant immediately followed by its OWN angles (so the
  // Listicle's "8 Reasons" angle nests under Listicle, not under whatever variant
  // happens to be last in the list).
  const entries = [...destVisits.entries()];
  const availableDestinations: Array<{ key: string; level: "pdp" | "variant" | "angle"; label: string; visits: number; parent?: string }> = [];
  for (const [k, v] of entries.filter(([, v]) => v.level === "pdp")) availableDestinations.push(mk(k, v));
  for (const [vk, vv] of entries.filter(([, v]) => v.level === "variant").sort((a, b) => b[1].visits - a[1].visits)) {
    availableDestinations.push(mk(vk, vv));
    for (const [ak, av] of entries.filter(([ak, v]) => v.level === "angle" && angleParent.get(ak) === vk).sort((a, b) => b[1].visits - a[1].visits)) {
      availableDestinations.push(mk(ak, av, vk));
    }
  }
  const placed = new Set(availableDestinations.map((d) => d.key));
  for (const [ak, av] of entries.filter(([k, v]) => v.level === "angle" && !placed.has(k))) availableDestinations.push(mk(ak, av));

  let destKey = args.destination && args.destination.trim() ? args.destination.trim() : null;
  if (!destKey) {
    const top = [...destVisits.entries()].filter(([, v]) => v.level !== "angle").sort((a, b) => b[1].visits - a[1].visits)[0];
    destKey = top ? top[0] : null;
  }
  if (!destKey) return { destination: null, availableDestinations, summary: null, funnelSteps: [], chapters: [] };
  const destLevel = destVisits.get(destKey)?.level ?? "variant";

  const selected = new Set<string>();
  for (const [sid, s] of sessByDest) {
    const ok = destLevel === "pdp" ? !s.variant : destLevel === "variant" ? s.variant === destKey : s.angle === destKey;
    if (ok) selected.add(sid);
  }
  const visits = selected.size;
  const destination = { key: destKey, label: labelFor(destKey, destLevel) };
  if (visits === 0) return { destination, availableDestinations, summary: null, funnelSteps: [], chapters: [] };

  // An event belongs to this destination's PAGE iff its stamped `lander_variant`
  // matches (new events — durable against chapter reordering). Old events lack
  // the stamp → fall back to the per-variant section allowlist.
  const destType = destLevel === "pdp" ? "pdp" : destLevel === "variant" ? destKey : (angleParent.get(destKey) || destKey);
  const allowedChapters = DESTINATION_CHAPTERS[destType] || null;
  const belongs = (m: Record<string, unknown>) => {
    const lv = m.lander_variant as string | undefined;
    if (lv) return lv === destType;
    const ch = m.chapter as string | undefined;
    return !allowedChapters || (!!ch && allowedChapters.has(ch));
  };

  const chapEvents = await fetchAllRows<{ event_type: string; session_id: string; meta: Record<string, unknown> }>(() =>
    admin.from("storefront_events").select("event_type, session_id, meta, id")
      .eq("workspace_id", workspaceId)
      .in("event_type", ["chapter_view", "chapter_dwell", "pack_selected", "pdp_engaged", "checkout_view", "order_placed"])
      .gte("created_at", startIso).lte("created_at", endIso).order("id", { ascending: true }),
  );

  const chapterSessions = new Map<string, Set<string>>();
  const chapterIndex = new Map<string, number>();
  const dwell = new Map<string, { sum: number; n: number }>();
  const ctaOrigin = new Map<string, number>();
  const pricingSessions = new Set<string>();
  const packedSessions = new Set<string>();
  // funnel-step sets for the selected destination (the waterfall)
  const engagedSet = new Set<string>(); const checkoutSet = new Set<string>(); const orderSet = new Set<string>();
  let jumped = 0, scrolled = 0;

  for (const e of chapEvents) {
    if (!selected.has(e.session_id)) continue;
    if (e.event_type === "pdp_engaged") { engagedSet.add(e.session_id); continue; }
    if (e.event_type === "checkout_view") { checkoutSet.add(e.session_id); continue; }
    if (e.event_type === "order_placed") { orderSet.add(e.session_id); continue; }
    if (e.event_type === "pack_selected") { packedSessions.add(e.session_id); continue; }
    const m = e.meta || {};
    const ch = m.chapter as string | undefined;
    if (!ch) continue;
    if (!belongs(m)) continue; // drop foreign-page (cross-nav) events
    if (e.event_type === "chapter_dwell") {
      const ms = Number(m.dwell_ms);
      if (Number.isFinite(ms)) { const d = dwell.get(ch) || { sum: 0, n: 0 }; d.sum += ms; d.n++; dwell.set(ch, d); }
      continue;
    }
    // chapter_view
    let set = chapterSessions.get(ch); if (!set) { set = new Set(); chapterSessions.set(ch, set); } set.add(e.session_id);
    const idx = Number(m.chapter_index); if (Number.isFinite(idx)) chapterIndex.set(ch, idx);
    if (PRICING_CHAPTERS.has(ch)) {
      pricingSessions.add(e.session_id);
      if (m.arrived_via_jump === true) { jumped++; const o = m.origin_chapter as string | undefined; if (o) ctaOrigin.set(o, (ctaOrigin.get(o) || 0) + 1); }
      else scrolled++;
    }
  }

  const chapters: ChapterRow[] = [...chapterSessions.entries()].map(([chapter, sess]) => {
    const reach = sess.size;
    const toPricing = [...sess].filter((id) => pricingSessions.has(id)).length;
    const toPack = [...sess].filter((id) => packedSessions.has(id)).length;
    const d = dwell.get(chapter);
    const co = ctaOrigin.get(chapter) || 0;
    return {
      chapter, label: chapterLabel(chapter, destType), index: chapterIndex.has(chapter) ? chapterIndex.get(chapter)! : null,
      reach, reach_pct: round1((100 * reach) / visits), avg_dwell_ms: d && d.n ? Math.round(d.sum / d.n) : 0,
      cta_origin: co, cta_origin_pct: jumped > 0 ? round1((100 * co) / jumped) : 0,
      view_to_pricing_pct: reach > 0 ? round1((100 * toPricing) / reach) : 0,
      view_to_pack_pct: reach > 0 ? round1((100 * toPack) / reach) : 0,
    };
  }).sort((a, b) => (a.index ?? 999) - (b.index ?? 999) || b.reach - a.reach);

  // reached_pricing/close are now page-accurate (pricing views on THIS page).
  const reachedPricing = pricingSessions.size;
  const packedAmongPricing = [...pricingSessions].filter((id) => packedSessions.has(id)).length;

  // 5-step funnel waterfall for the selected destination (visit→engaged→pack→checkout→order)
  const stepCounts: Array<{ step: string; label: string; count: number }> = [
    { step: "visit", label: "Visit", count: visits },
    { step: "engaged", label: "Engaged", count: engagedSet.size },
    { step: "pack_selected", label: "Pack selected", count: packedSessions.size },
    { step: "checkout_started", label: "Checkout started", count: checkoutSet.size },
    { step: "order_placed", label: "Order placed", count: orderSet.size },
  ];
  const funnelSteps: FunnelStep[] = stepCounts.map((c, i) => {
    const prev = i > 0 ? stepCounts[i - 1].count : c.count;
    return {
      step: c.step, label: c.label, count: c.count,
      conv_from_prev_pct: prev > 0 ? round1((100 * c.count) / prev) : 0,
      conv_from_top_pct: visits > 0 ? round1((100 * c.count) / visits) : 0,
      drop_from_prev: i > 0 ? Math.max(0, prev - c.count) : 0,
    };
  });

  return {
    destination,
    availableDestinations,
    summary: {
      visits, reached_pricing: reachedPricing, carry_to_pricing_pct: round1((100 * reachedPricing) / visits),
      packed: packedSessions.size, close_pct: reachedPricing > 0 ? round1((100 * packedAmongPricing) / reachedPricing) : 0,
      jumped_to_pricing: jumped, scrolled_to_pricing: scrolled,
    },
    funnelSteps,
    chapters,
  };
}

// ───────────────── Bottleneck classifier (a Max decision signal) ─────────────────
// For each destination (PDP + variants), the two conversion levers — carry-to-
// pricing (engagement) and close (offer) — benchmarked against the best-in-class
// destination, so Max knows WHICH lever is the binding constraint and what KIND of
// fix it implies. Page-accurate (lander_variant stamp / allowlist), matching the
// chapter-diagnostics card. Primarily a signal for the Growth director; surfaced
// compactly on the funnel page for oversight.

export type Bottleneck = "carry" | "close" | "balanced" | "insufficient_data";
export interface BottleneckVerdict {
  key: string;
  label: string;
  visits: number;
  reached_pricing: number;
  carry_to_pricing_pct: number;
  close_pct: number;
  bottleneck: Bottleneck;
  /** headroom to best-in-class on each lever (percentage points) */
  carry_gap_pct: number;
  close_gap_pct: number;
  recommendation: string;
  confidence: "low" | "medium" | "high";
  /** traffic-weighted opportunity = visits × dominant gap; ranks where to act */
  priority: number;
}
export interface BottlenecksResult {
  destinations: BottleneckVerdict[]; // sorted by priority desc
  benchmark: { best_carry_pct: number; best_close_pct: number };
}

const BN_MIN_VISITS = 30;
const BN_MIN_PRICING = 10;

export async function computeBottlenecks(args: {
  admin: Admin; workspaceId: string; startIso: string; endIso: string;
  productHandle?: string | null; utmSource?: string | null; referrer?: string | null;
}): Promise<BottlenecksResult> {
  const { admin, workspaceId, startIso, endIso } = args;
  const product = args.productHandle ? args.productHandle.toLowerCase() : null;
  const utmWanted = args.utmSource && args.utmSource.trim() ? args.utmSource.trim().toLowerCase() : null;
  const refWanted = args.referrer && args.referrer.trim() ? args.referrer.trim() : null;

  const [{ data: productRows }, { data: internalCustomerRows }] = await Promise.all([
    admin.from("products").select("handle").eq("workspace_id", workspaceId),
    admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("is_internal", true),
  ]);
  const handleSet = new Set<string>((productRows || []).map((p) => String(p.handle).toLowerCase()));
  const internalCustomerIds = new Set<string>((internalCustomerRows || []).map((c) => c.id as string));

  const eventRows = await fetchAllRows<{ session_id: string }>(() =>
    admin.from("storefront_events").select("session_id, id")
      .eq("workspace_id", workspaceId).gte("created_at", startIso).lte("created_at", endIso).order("id", { ascending: true }),
  );
  const universe = new Set<string>(eventRows.map((e) => e.session_id));

  // session → its landing destination ('pdp' | variant)
  const sessDest = new Map<string, string>();
  const ids = [...universe];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await admin.from("storefront_sessions")
      .select("id, landing_url, is_internal, is_bot, customer_id, utm_source, referrer").in("id", ids.slice(i, i + 300));
    for (const s of data || []) {
      if (s.is_internal || s.is_bot) continue;
      if (s.customer_id && internalCustomerIds.has(s.customer_id as string)) continue;
      if (!matchUtm((s.utm_source as string) ?? null, utmWanted)) continue;
      if (!matchRef((s.referrer as string) ?? null, refWanted)) continue;
      const { segments, variant } = parseLanding((s.landing_url as string) ?? null);
      const handle = resolveHandle(segments, handleSet);
      if (product && handle !== product) continue;
      if (!handle) continue; // bottleneck is per product-destination only
      sessDest.set(s.id as string, variant || "pdp");
    }
  }

  // page-accurate pricing reach + pack per session (matches chapter-diagnostics)
  const chapEvents = await fetchAllRows<{ event_type: string; session_id: string; meta: Record<string, unknown> }>(() =>
    admin.from("storefront_events").select("event_type, session_id, meta, id")
      .eq("workspace_id", workspaceId).in("event_type", ["chapter_view", "pack_selected"])
      .gte("created_at", startIso).lte("created_at", endIso).order("id", { ascending: true }),
  );
  const reachedPricing = new Set<string>();
  const packed = new Set<string>();
  for (const e of chapEvents) {
    const dest = sessDest.get(e.session_id);
    if (!dest) continue;
    if (e.event_type === "pack_selected") { packed.add(e.session_id); continue; }
    const m = e.meta || {};
    if (!PRICING_CHAPTERS.has(m.chapter as string)) continue;
    const lv = m.lander_variant as string | undefined;
    const onPage = lv ? lv === dest : true; // stamped → must match; unstamped → assume on-page
    if (onPage) reachedPricing.add(e.session_id);
  }

  // aggregate per destination
  const VARIANT_DEST_LABEL = (d: string) => (d === "pdp" ? "Product Page (bare PDP)" : VARIANT_LABEL[d] || d);
  type Agg = { visits: number; reached: number; packedReached: number };
  const agg = new Map<string, Agg>();
  for (const [sid, dest] of sessDest) {
    const a = agg.get(dest) || { visits: 0, reached: 0, packedReached: 0 };
    a.visits++;
    const r = reachedPricing.has(sid);
    if (r) a.reached++;
    if (r && packed.has(sid)) a.packedReached++;
    agg.set(dest, a);
  }

  const rows = [...agg.entries()].map(([key, a]) => ({
    key,
    carry: a.visits > 0 ? (100 * a.reached) / a.visits : 0,
    close: a.reached > 0 ? (100 * a.packedReached) / a.reached : 0,
    a,
  }));
  // best-in-class benchmark among destinations with enough data
  const eligible = rows.filter((r) => r.a.visits >= BN_MIN_VISITS && r.a.reached >= BN_MIN_PRICING);
  const bestCarry = eligible.length ? Math.max(...eligible.map((r) => r.carry)) : 0;
  const bestClose = eligible.length ? Math.max(...eligible.map((r) => r.close)) : 0;

  const verdicts: BottleneckVerdict[] = rows.map((r) => {
    const enough = r.a.visits >= BN_MIN_VISITS && r.a.reached >= BN_MIN_PRICING;
    const carryGap = Math.max(0, bestCarry - r.carry);
    const closeGap = Math.max(0, bestClose - r.close);
    let bottleneck: Bottleneck;
    let recommendation: string;
    if (!enough) {
      bottleneck = "insufficient_data";
      recommendation = `Not enough traffic to diagnose (need ≥${BN_MIN_VISITS} visits, ≥${BN_MIN_PRICING} reaching pricing).`;
    } else if (carryGap < 5 && closeGap < 5) {
      bottleneck = "balanced";
      recommendation = "Near best-in-class on both levers — scale it, or test a different destination.";
    } else if (carryGap >= closeGap) {
      bottleneck = "carry";
      recommendation = `Sequence leaks before pricing (carry ${r.carry.toFixed(0)}% vs best ${bestCarry.toFixed(0)}%). Find the drop-off chapter and fix/move it.`;
    } else {
      bottleneck = "close";
      recommendation = `Reaches pricing but doesn't close (close ${r.close.toFixed(0)}% vs best ${bestClose.toFixed(0)}%). Rework the pricing/offer for this traffic.`;
    }
    const dominantGap = bottleneck === "carry" ? carryGap : bottleneck === "close" ? closeGap : 0;
    const confidence: BottleneckVerdict["confidence"] = r.a.reached >= 30 ? "high" : r.a.reached >= BN_MIN_PRICING ? "medium" : "low";
    return {
      key: r.key, label: VARIANT_DEST_LABEL(r.key),
      visits: r.a.visits, reached_pricing: r.a.reached,
      carry_to_pricing_pct: round1(r.carry), close_pct: round1(r.close),
      bottleneck, carry_gap_pct: round1(carryGap), close_gap_pct: round1(closeGap),
      recommendation, confidence,
      priority: Math.round(r.a.visits * (dominantGap / 100)),
    };
  }).sort((x, y) => y.priority - x.priority);

  return { destinations: verdicts, benchmark: { best_carry_pct: round1(bestCarry), best_close_pct: round1(bestClose) } };
}

// ───────────────── Dimension breakdowns (device / country) ─────────────────
// Per device_type / ip_country: visits + CVR + LTV/visit, so a high-traffic
// segment that doesn't convert (e.g. tablet layout bug, PR shipping friction)
// is visible. Slice-aware (Product × Source × Referrer). Source is NOT a
// breakdown here — it's a page slice.
export interface BreakdownRow { value: string; visits: number; orders: number; cvr: number; ltv_per_visit_cents: number; }
export interface BreakdownsResult { device: BreakdownRow[]; country: BreakdownRow[]; language: BreakdownRow[]; }

const LANG_LABEL: Record<string, string> = { es: "Spanish (es)", en: "English (en)", pt: "Portuguese (pt)", fr: "French (fr)" };
function languageBucket(raw: string | null): string {
  const p = (raw || "").split("-")[0].toLowerCase();
  return p ? (LANG_LABEL[p] || p) : "(not captured)";
}

export async function computeBreakdowns(args: {
  admin: Admin; workspaceId: string; startIso: string; endIso: string;
  productHandle?: string | null; utmSource?: string | null; referrer?: string | null;
  churnTrailingMonths?: number | null;
}): Promise<BreakdownsResult> {
  const { admin, workspaceId, startIso, endIso } = args;
  const product = args.productHandle ? args.productHandle.toLowerCase() : null;
  const utmWanted = args.utmSource && args.utmSource.trim() ? args.utmSource.trim().toLowerCase() : null;
  const refWanted = args.referrer && args.referrer.trim() ? args.referrer.trim() : null;

  const [{ data: productRows }, { data: internalCustomerRows }, churn] = await Promise.all([
    admin.from("products").select("handle").eq("workspace_id", workspaceId),
    admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("is_internal", true),
    getMonthlyChurn({ admin, workspaceId, trailingMonths: args.churnTrailingMonths }),
  ]);
  const handleSet = new Set<string>((productRows || []).map((p) => String(p.handle).toLowerCase()));
  const internalCustomerIds = new Set<string>((internalCustomerRows || []).map((c) => c.id as string));
  const subLO = churn.sub_lifetime_orders;

  const eventRows = await fetchAllRows<{ session_id: string }>(() =>
    admin.from("storefront_events").select("session_id, id")
      .eq("workspace_id", workspaceId).gte("created_at", startIso).lte("created_at", endIso).order("id", { ascending: true }),
  );
  const universe = new Set<string>(eventRows.map((e) => e.session_id));
  const sessionIds = [...universe];

  // order revenue/ltv + who ordered (from the order_placed EVENT, reliably session-linked)
  const orderEvents = await fetchAllRows<{ session_id: string; meta: Record<string, unknown> }>(() =>
    admin.from("storefront_events").select("session_id, meta, id")
      .eq("workspace_id", workspaceId).eq("event_type", "order_placed")
      .gte("created_at", startIso).lte("created_at", endIso).order("id", { ascending: true }),
  );
  const orderIds = [...new Set(orderEvents.map((e) => String((e.meta || {}).order_id || "")).filter(Boolean))];
  const subByOrderId = new Map<string, boolean>();
  for (let i = 0; i < orderIds.length; i += 300) {
    const { data } = await admin.from("orders").select("id, subscription_id").in("id", orderIds.slice(i, i + 300));
    for (const o of data || []) subByOrderId.set(o.id as string, !!o.subscription_id);
  }
  const orderBySession = new Map<string, { ltv: number; ordered: boolean }>();
  for (const e of orderEvents) {
    const m = e.meta || {};
    const cents = Number(m.total_cents) || 0;
    const oid = String(m.order_id || "");
    const isSub = oid ? (subByOrderId.get(oid) ?? false) : false;
    const cur = orderBySession.get(e.session_id) || { ltv: 0, ordered: false };
    cur.ltv += cents * (isSub ? subLO : 1);
    cur.ordered = true;
    orderBySession.set(e.session_id, cur);
  }

  type Agg = { visits: number; orders: number; ltv: number };
  const device = new Map<string, Agg>();
  const country = new Map<string, Agg>();
  const language = new Map<string, Agg>();
  const bump = (map: Map<string, Agg>, key: string, ordered: boolean, ltv: number) => {
    const a = map.get(key) || { visits: 0, orders: 0, ltv: 0 };
    a.visits++; if (ordered) a.orders++; a.ltv += ltv; map.set(key, a);
  };

  for (let i = 0; i < sessionIds.length; i += 300) {
    const { data } = await admin.from("storefront_sessions")
      .select("id, landing_url, is_internal, is_bot, customer_id, utm_source, referrer, device_type, ip_country, browser_language")
      .in("id", sessionIds.slice(i, i + 300));
    for (const s of data || []) {
      if (s.is_internal || s.is_bot) continue;
      if (s.customer_id && internalCustomerIds.has(s.customer_id as string)) continue;
      if (!matchUtm((s.utm_source as string) ?? null, utmWanted)) continue;
      if (!matchRef((s.referrer as string) ?? null, refWanted)) continue;
      if (product) {
        const { segments } = parseLanding((s.landing_url as string) ?? null);
        if (resolveHandle(segments, handleSet) !== product) continue;
      }
      const ov = orderBySession.get(s.id as string);
      const ordered = !!ov?.ordered;
      const ltv = ov?.ltv || 0;
      bump(device, (s.device_type as string) || "unknown", ordered, ltv);
      bump(country, (s.ip_country as string) || "—", ordered, ltv);
      bump(language, languageBucket((s.browser_language as string) ?? null), ordered, ltv);
    }
  }

  const toRows = (map: Map<string, Agg>): BreakdownRow[] =>
    [...map.entries()].map(([value, a]) => ({
      value, visits: a.visits, orders: a.orders,
      cvr: a.visits > 0 ? round1((100 * a.orders) / a.visits) : 0,
      ltv_per_visit_cents: a.visits > 0 ? Math.round(a.ltv / a.visits) : 0,
    })).sort((x, y) => y.visits - x.visits);

  return { device: toRows(device), country: toRows(country), language: toRows(language) };
}

// ───────────────── Cart + lead analytics (summary, slice-aware) ─────────────────
// Abandoned-cart SUMMARY (no per-cart logs) + lead capture, sliceable by
// Product × Source × Referrer + a destination (pdp/variant), joined through the
// cart/lead session (anonymous_id / session_id → storefront_sessions). Fixes the
// recovery metric: a reminded cart counts as RECOVERED if its customer ordered
// AFTER the reminder (even via a NEW cart) — the old converted_order_id-only check
// missed returns-via-new-cart. Also flags mis-fired reminders (sent to a customer
// who had already ordered).
export interface CartAnalyticsResult {
  abandoned: {
    open_with_email: number;
    carts_reminded: number;
    followups_sent: number; // step 2 of the 2-step sequence
    recovered: number;
    recovery_rate_pct: number;
    revenue_recovered_cents: number;
    misfired_reminders: number;
    fast_converted_in_session: number;
  };
  leads: { emails: number; phones: number };
}

export async function computeCartAnalytics(args: {
  admin: Admin; workspaceId: string; startIso: string; endIso: string;
  productHandle?: string | null; utmSource?: string | null; referrer?: string | null; destination?: string | null;
}): Promise<CartAnalyticsResult> {
  const { admin, workspaceId, startIso, endIso } = args;
  const product = args.productHandle ? args.productHandle.toLowerCase() : null;
  const utmWanted = args.utmSource && args.utmSource.trim() ? args.utmSource.trim().toLowerCase() : null;
  const refWanted = args.referrer && args.referrer.trim() ? args.referrer.trim() : null;
  const destWanted = args.destination && args.destination.trim() ? args.destination.trim() : null;

  const [{ data: productRows }, { data: internalCustomerRows }] = await Promise.all([
    admin.from("products").select("handle").eq("workspace_id", workspaceId),
    admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("is_internal", true),
  ]);
  const handleSet = new Set<string>((productRows || []).map((p) => String(p.handle).toLowerCase()));
  const internalCustomerIds = new Set<string>((internalCustomerRows || []).map((c) => c.id as string));

  // carts in window
  const carts = await fetchAllRows<{ id: string; email: string | null; status: string; anonymous_id: string | null; customer_id: string | null; subtotal_cents: number | null; total_cents: number | null; abandoned_email_sent_at: string | null; abandoned_followup_sent_at: string | null; converted_order_id: string | null; created_at: string; updated_at: string }>(() =>
    admin.from("cart_drafts")
      .select("id, email, status, anonymous_id, customer_id, subtotal_cents, total_cents, abandoned_email_sent_at, abandoned_followup_sent_at, converted_order_id, created_at, updated_at, id")
      .eq("workspace_id", workspaceId).gte("created_at", startIso).lte("created_at", endIso).order("created_at", { ascending: true }),
  );

  // leads in window
  const leadRows = await fetchAllRows<{ email: string | null; phone: string | null; anonymous_id: string | null }>(() =>
    admin.from("storefront_leads").select("email, phone, anonymous_id, id")
      .eq("workspace_id", workspaceId).gte("created_at", startIso).lte("created_at", endIso).order("id", { ascending: true }),
  );

  // slice/destination filter: classify each cart/lead session by anonymous_id
  const anonIds = [...new Set([...carts.map((c) => c.anonymous_id), ...leadRows.map((l) => l.anonymous_id)].filter(Boolean) as string[])];
  const sessByAnon = new Map<string, { variant: string | null; ok: boolean }>();
  for (let i = 0; i < anonIds.length; i += 300) {
    const { data } = await admin.from("storefront_sessions")
      .select("anonymous_id, landing_url, is_internal, is_bot, customer_id, utm_source, referrer")
      .eq("workspace_id", workspaceId).in("anonymous_id", anonIds.slice(i, i + 300));
    for (const s of data || []) {
      let ok = !s.is_internal && !s.is_bot && !(s.customer_id && internalCustomerIds.has(s.customer_id as string));
      ok = ok && matchUtm((s.utm_source as string) ?? null, utmWanted) && matchRef((s.referrer as string) ?? null, refWanted);
      const { segments, variant } = parseLanding((s.landing_url as string) ?? null);
      if (ok && product && resolveHandle(segments, handleSet) !== product) ok = false;
      sessByAnon.set(s.anonymous_id as string, { variant, ok });
    }
  }
  const cartInScope = (c: { anonymous_id: string | null }) => {
    if (!utmWanted && !refWanted && !product && !destWanted) return true; // no slice → all carts
    if (!c.anonymous_id) return false;
    const s = sessByAnon.get(c.anonymous_id);
    if (!s || !s.ok) return false;
    if (destWanted) return destWanted === "pdp" ? !s.variant : s.variant === destWanted;
    return true;
  };
  const scoped = carts.filter(cartInScope);

  // recovery: cart email → did the customer order AFTER the reminder?
  //
  // Phase 3 of docs/brain/specs/rpc-ify-aggregation-layer-fix-1000-row-truncation.md.
  // Prior code chunked customer_ids in groups of 200 and issued .in("customer_id", chunk)
  // against orders — a chunk that matched >1000 order rows silently dropped
  // rows past PostgREST's 1000-row cap, so the post-reminder purchase test
  // under-counted recovered carts on any high-order-count workspace. Server-side
  // GROUP BY email → array_agg(created_at) now.
  const emails = [...new Set(scoped.map((c) => (c.email || "").toLowerCase()).filter(Boolean))];
  const orderTimesByEmail = new Map<string, number[]>();
  if (emails.length) {
    for (let i = 0; i < emails.length; i += 500) {
      const { data } = await admin.rpc("order_times_by_email", {
        p_workspace: workspaceId,
        p_emails: emails.slice(i, i + 500),
      });
      for (const row of (data ?? []) as Array<{ email: string; order_times: string[] | null }>) {
        const times = (row.order_times ?? []).map((t) => new Date(t).getTime()).filter((n) => Number.isFinite(n));
        const key = String(row.email).toLowerCase();
        const arr = orderTimesByEmail.get(key) || [];
        arr.push(...times);
        orderTimesByEmail.set(key, arr);
      }
    }
  }

  let open_with_email = 0, carts_reminded = 0, followups_sent = 0, recovered = 0, misfired = 0, fast = 0, revenueRecovered = 0;
  for (const c of scoped) {
    const hasEmail = !!(c.email && c.email.trim());
    if (c.status === "open" && hasEmail) open_with_email++;
    if (c.abandoned_email_sent_at) {
      carts_reminded++;
      if (c.abandoned_followup_sent_at) followups_sent++;
      const remind = new Date(c.abandoned_email_sent_at).getTime();
      const times = orderTimesByEmail.get((c.email || "").toLowerCase()) || [];
      if (times.some((t) => t > remind)) { recovered++; revenueRecovered += Number(c.total_cents || c.subtotal_cents || 0); }
      if (times.some((t) => t <= remind)) misfired++;
    } else if (c.converted_order_id && new Date(c.updated_at).getTime() < new Date(c.created_at).getTime() + 30 * 60_000) {
      fast++;
    }
  }

  // leads (sliced via the same anonymous_id → session scope built above)
  const leadInScope = (l: { anonymous_id: string | null }) => {
    if (!utmWanted && !refWanted && !product && !destWanted) return true;
    if (!l.anonymous_id) return false;
    const s = sessByAnon.get(l.anonymous_id);
    if (!s) return false; // lead's session not in the (carts') scope map — best-effort
    if (!s.ok) return false;
    if (destWanted) return destWanted === "pdp" ? !s.variant : s.variant === destWanted;
    return true;
  };
  const scopedLeads = leadRows.filter(leadInScope);
  const emailsCount = scopedLeads.filter((l) => l.email && l.email.trim()).length;
  const phonesCount = scopedLeads.filter((l) => l.phone && l.phone.trim()).length;

  return {
    abandoned: {
      open_with_email, carts_reminded, followups_sent, recovered,
      recovery_rate_pct: carts_reminded > 0 ? round1((100 * recovered) / carts_reminded) : 0,
      revenue_recovered_cents: revenueRecovered, misfired_reminders: misfired, fast_converted_in_session: fast,
    },
    leads: { emails: emailsCount, phones: phonesCount },
  };
}

// ───────────────── Lead-capture popup funnel (slice-aware) ─────────────────
// Per popup variant (discount=Offer, quiz=Survey): shown→engaged→email(step1)→
// phone(step2), from popup_decisions + storefront_leads, sliceable by
// Product × Source × Referrer + a lander destination (via session_id → session).
export interface PopupFunnelResult {
  byVariant: Array<{ variant: string; label: string; shown: number; engaged: number; email: number; phone: number }>;
  totals: { shown: number; engaged: number; email: number; phone: number };
}

export async function computePopupFunnel(args: {
  admin: Admin; workspaceId: string; startIso: string; endIso: string;
  productHandle?: string | null; utmSource?: string | null; referrer?: string | null; destination?: string | null;
}): Promise<PopupFunnelResult> {
  const { admin, workspaceId, startIso, endIso } = args;
  const product = args.productHandle ? args.productHandle.toLowerCase() : null;
  const utmWanted = args.utmSource && args.utmSource.trim() ? args.utmSource.trim().toLowerCase() : null;
  const refWanted = args.referrer && args.referrer.trim() ? args.referrer.trim() : null;
  const destWanted = args.destination && args.destination.trim() ? args.destination.trim() : null;
  const sliced = !!(product || utmWanted || refWanted || destWanted);

  const [{ data: productRows }, { data: internalCustomerRows }, { data: decisions }, { data: leads }] = await Promise.all([
    admin.from("products").select("handle").eq("workspace_id", workspaceId),
    admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("is_internal", true),
    admin.from("popup_decisions").select("variant, shown, engaged, converted, session_id").eq("workspace_id", workspaceId).gte("created_at", startIso).lte("created_at", endIso),
    admin.from("storefront_leads").select("source, email, session_id").eq("workspace_id", workspaceId).gte("created_at", startIso).lte("created_at", endIso),
  ]);
  const handleSet = new Set<string>((productRows || []).map((p) => String(p.handle).toLowerCase()));
  const internalCustomerIds = new Set<string>((internalCustomerRows || []).map((c) => c.id as string));

  // scope by session_id (uuid) → session
  const sids = [...new Set([...(decisions || []).map((d) => d.session_id), ...(leads || []).map((l) => l.session_id)].filter(Boolean) as string[])];
  const scope = new Map<string, boolean>();
  for (let i = 0; i < sids.length; i += 300) {
    const { data } = await admin.from("storefront_sessions")
      .select("id, landing_url, is_internal, is_bot, customer_id, utm_source, referrer")
      .in("id", sids.slice(i, i + 300));
    for (const s of data || []) {
      let ok = !s.is_internal && !s.is_bot && !(s.customer_id && internalCustomerIds.has(s.customer_id as string));
      ok = ok && matchUtm((s.utm_source as string) ?? null, utmWanted) && matchRef((s.referrer as string) ?? null, refWanted);
      const { segments, variant } = parseLanding((s.landing_url as string) ?? null);
      if (ok && product && resolveHandle(segments, handleSet) !== product) ok = false;
      if (ok && destWanted) ok = destWanted === "pdp" ? !variant : variant === destWanted;
      scope.set(s.id as string, ok);
    }
  }
  const inScope = (sid: string | null) => !sliced ? !(sid && scope.get(sid) === false && sids.includes(sid)) : !!(sid && scope.get(sid));
  // when NOT sliced we still exclude internal/bot: treat unknown as ok, known-false as excluded
  const okUnsliced = (sid: string | null) => !sid || scope.get(sid) !== false;

  const byVariant = new Map([
    ["discount", { variant: "discount", label: "Offer", shown: 0, engaged: 0, email: 0, phone: 0 }],
    ["quiz", { variant: "quiz", label: "Survey", shown: 0, engaged: 0, email: 0, phone: 0 }],
  ]);
  const pass = (sid: string | null) => (sliced ? inScope(sid) : okUnsliced(sid));
  for (const r of (decisions || []) as { variant: string; shown: boolean; engaged: boolean; converted: boolean; session_id: string | null }[]) {
    if (!pass(r.session_id)) continue;
    const v = byVariant.get(r.variant); if (!v) continue;
    if (r.shown) v.shown++;
    if (r.engaged) v.engaged++;
    if (r.converted) v.phone++;
  }
  const sourceToVariant: Record<string, string> = { popup_discount: "discount", popup_quiz: "quiz" };
  for (const r of (leads || []) as { source: string | null; email: string | null; session_id: string | null }[]) {
    if (!r.email || !pass(r.session_id)) continue;
    const v = byVariant.get(sourceToVariant[r.source || ""] || ""); if (v) v.email++;
  }
  const rows = [...byVariant.values()];
  const totals = rows.reduce((a, v) => ({ shown: a.shown + v.shown, engaged: a.engaged + v.engaged, email: a.email + v.email, phone: a.phone + v.phone }), { shown: 0, engaged: 0, email: 0, phone: 0 });
  return { byVariant: rows, totals };
}

// ───────────────── Survey chapter funnel + answers (slice-aware) ─────────────────
// shown → step (q1 cups → q2 goal → q3 style → result) → completed → email, plus
// the ANSWER distributions (cups_per_day / health_goal / coffee_style from
// survey_completed). Reads survey_* events (allowlisted 2026-06-30 — they were
// dropped before, which zeroed this card). Slice + destination aware.
export interface SurveyFunnelResult {
  shown: number;
  steps: Array<{ step: string; label: string; reached: number; pct_of_shown: number }>;
  completed: number;
  email: number;
  answers: { cups_per_day: Array<{ value: string; count: number }>; health_goal: Array<{ value: string; count: number }>; coffee_style: Array<{ value: string; count: number }> };
}

const SURVEY_STEP_LABEL: Record<string, string> = { q1: "Q1 · Cups/day", q2: "Q2 · Goal", q3: "Q3 · Style", result: "Result" };

// ───────────────── Running experiments (bandit arms, SDK) ─────────────────
// Reads the persisted per-arm rollup (storefront_experiment_variants) — now
// correct after the jsonb .contains() fix — + win-prob vs control. Cross-variant
// by nature (no product/destination slice — the arms ARE the comparison).
export interface RunningExperimentArm { variant_id: string; label: string; is_control: boolean; sessions: number; conversions: number; sub_attach: number; cvr: number; win_prob: number | null }
export interface RunningExperiment { experiment_id: string; product_id: string; lever: string; lander_type: string; status: string; holdout_pct: number; arms: RunningExperimentArm[] }

export async function computeRunningExperiments(args: { admin: Admin; workspaceId: string }): Promise<RunningExperiment[]> {
  const { admin, workspaceId } = args;
  const { data: exps } = await admin.from("storefront_experiments")
    .select("id, product_id, lever, lander_type, status, holdout_pct")
    .eq("workspace_id", workspaceId).in("status", ["running", "promoted"]).order("created_at", { ascending: false });
  if (!exps || exps.length === 0) return [];
  const { data: variants } = await admin.from("storefront_experiment_variants")
    .select("id, experiment_id, label, is_control, sessions, conversions, sub_attach, alpha, beta")
    .in("experiment_id", exps.map((e) => e.id));
  const byExp = new Map<string, typeof variants>();
  for (const v of variants || []) { const a = byExp.get(v.experiment_id as string) || []; a!.push(v); byExp.set(v.experiment_id as string, a!); }

  return exps.map((e) => {
    const vs = byExp.get(e.id as string) || [];
    const control = vs.find((v) => v.is_control);
    const arms: RunningExperimentArm[] = vs.map((v) => {
      const sessions = Number(v.sessions) || 0;
      const conversions = Number(v.conversions) || 0;
      return {
        variant_id: v.id as string, label: v.label as string, is_control: !!v.is_control,
        sessions, conversions, sub_attach: Number(v.sub_attach) || 0,
        cvr: sessions > 0 ? round1((100 * conversions) / sessions) : 0,
        win_prob: v.is_control || !control ? null : Math.round(winProbabilityVsControl(v as never, control as never, 2000) * 100) / 100,
      };
    }).sort((a, b) => (a.is_control ? -1 : 1) - (b.is_control ? -1 : 1));
    return { experiment_id: e.id as string, product_id: e.product_id as string, lever: e.lever as string, lander_type: e.lander_type as string, status: e.status as string, holdout_pct: Number(e.holdout_pct) || 0, arms };
  });
}

// ───────────────── Pack-size breakdown (AOV / decoy analysis, slice-aware) ─────────────────
export interface PackBreakdownRow { label: string; count: number; pct: number }
const PACK_ORDER = ["1-pack", "2-pack", "3-pack", "Single (qty n/a)", "Bundle 1×1", "Bundle 2×2", "Bundle"];

export async function computePackBreakdown(args: {
  admin: Admin; workspaceId: string; startIso: string; endIso: string;
  productHandle?: string | null; utmSource?: string | null; referrer?: string | null; destination?: string | null;
}): Promise<{ rows: PackBreakdownRow[] }> {
  const { admin, workspaceId, startIso, endIso } = args;
  const product = args.productHandle ? args.productHandle.toLowerCase() : null;
  const utmWanted = args.utmSource && args.utmSource.trim() ? args.utmSource.trim().toLowerCase() : null;
  const refWanted = args.referrer && args.referrer.trim() ? args.referrer.trim() : null;
  const destWanted = args.destination && args.destination.trim() ? args.destination.trim() : null;
  const sliced = !!(product || utmWanted || refWanted || destWanted);

  const [{ data: productRows }, { data: internalCustomerRows }] = await Promise.all([
    admin.from("products").select("handle").eq("workspace_id", workspaceId),
    admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("is_internal", true),
  ]);
  const handleSet = new Set<string>((productRows || []).map((p) => String(p.handle).toLowerCase()));
  const internalCustomerIds = new Set<string>((internalCustomerRows || []).map((c) => c.id as string));

  const events = await fetchAllRows<{ session_id: string; meta: Record<string, unknown> }>(() =>
    admin.from("storefront_events").select("session_id, meta, id")
      .eq("workspace_id", workspaceId).eq("event_type", "pack_selected")
      .gte("created_at", startIso).lte("created_at", endIso).order("id", { ascending: true }),
  );
  const sids = [...new Set(events.map((e) => e.session_id).filter(Boolean))];
  const scope = new Map<string, boolean>();
  for (let i = 0; i < sids.length; i += 300) {
    const { data } = await admin.from("storefront_sessions")
      .select("id, landing_url, is_internal, is_bot, customer_id, utm_source, referrer").in("id", sids.slice(i, i + 300));
    for (const s of data || []) {
      let ok = !s.is_internal && !s.is_bot && !(s.customer_id && internalCustomerIds.has(s.customer_id as string));
      ok = ok && matchUtm((s.utm_source as string) ?? null, utmWanted) && matchRef((s.referrer as string) ?? null, refWanted);
      const { segments, variant } = parseLanding((s.landing_url as string) ?? null);
      if (ok && product && resolveHandle(segments, handleSet) !== product) ok = false;
      if (ok && destWanted) ok = destWanted === "pdp" ? !variant : variant === destWanted;
      scope.set(s.id as string, ok);
    }
  }
  const pass = (sid: string) => (sliced ? scope.get(sid) === true : scope.get(sid) !== false);

  const counts = new Map<string, number>();
  for (const e of events) {
    if (!e.session_id || !pass(e.session_id)) continue;
    const m = e.meta || {};
    let label: string;
    if (m.bundle) { const bs = typeof m.bundle_size === "number" ? m.bundle_size : null; label = bs ? `Bundle ${bs}×${bs}` : "Bundle"; }
    else { const q = typeof m.quantity === "number" ? m.quantity : null; label = q ? `${q}-pack` : "Single (qty n/a)"; }
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0) || 1;
  const rows = [...counts.entries()]
    .map(([label, count]) => ({ label, count, pct: round1((100 * count) / total) }))
    .sort((a, b) => (PACK_ORDER.indexOf(a.label) + 1 || 99) - (PACK_ORDER.indexOf(b.label) + 1 || 99) || b.count - a.count);
  return { rows };
}

export async function computeSurveyFunnel(args: {
  admin: Admin; workspaceId: string; startIso: string; endIso: string;
  productHandle?: string | null; utmSource?: string | null; referrer?: string | null; destination?: string | null;
}): Promise<SurveyFunnelResult> {
  const { admin, workspaceId, startIso, endIso } = args;
  const product = args.productHandle ? args.productHandle.toLowerCase() : null;
  const utmWanted = args.utmSource && args.utmSource.trim() ? args.utmSource.trim().toLowerCase() : null;
  const refWanted = args.referrer && args.referrer.trim() ? args.referrer.trim() : null;
  const destWanted = args.destination && args.destination.trim() ? args.destination.trim() : null;
  const sliced = !!(product || utmWanted || refWanted || destWanted);

  const [{ data: productRows }, { data: internalCustomerRows }] = await Promise.all([
    admin.from("products").select("handle").eq("workspace_id", workspaceId),
    admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("is_internal", true),
  ]);
  const handleSet = new Set<string>((productRows || []).map((p) => String(p.handle).toLowerCase()));
  const internalCustomerIds = new Set<string>((internalCustomerRows || []).map((c) => c.id as string));

  const events = await fetchAllRows<{ event_type: string; session_id: string; meta: Record<string, unknown> }>(() =>
    admin.from("storefront_events").select("event_type, session_id, meta, id")
      .eq("workspace_id", workspaceId).in("event_type", ["survey_shown", "survey_step", "survey_completed", "lead_captured"])
      .gte("created_at", startIso).lte("created_at", endIso).order("id", { ascending: true }),
  );
  const sids = [...new Set(events.map((e) => e.session_id).filter(Boolean))];
  const scope = new Map<string, boolean>();
  for (let i = 0; i < sids.length; i += 300) {
    const { data } = await admin.from("storefront_sessions")
      .select("id, landing_url, is_internal, is_bot, customer_id, utm_source, referrer").in("id", sids.slice(i, i + 300));
    for (const s of data || []) {
      let ok = !s.is_internal && !s.is_bot && !(s.customer_id && internalCustomerIds.has(s.customer_id as string));
      ok = ok && matchUtm((s.utm_source as string) ?? null, utmWanted) && matchRef((s.referrer as string) ?? null, refWanted);
      const { segments, variant } = parseLanding((s.landing_url as string) ?? null);
      if (ok && product && resolveHandle(segments, handleSet) !== product) ok = false;
      if (ok && destWanted) ok = destWanted === "pdp" ? !variant : variant === destWanted;
      scope.set(s.id as string, ok);
    }
  }
  const pass = (sid: string) => (sliced ? scope.get(sid) === true : scope.get(sid) !== false);

  const shown = new Set<string>(), completed = new Set<string>(), email = new Set<string>();
  const stepReached = new Map<string, Set<string>>();
  const answers = { cups_per_day: new Map<string, number>(), health_goal: new Map<string, number>(), coffee_style: new Map<string, number>() };
  for (const e of events) {
    if (!e.session_id || !pass(e.session_id)) continue;
    const m = e.meta || {};
    if (e.event_type === "survey_shown") shown.add(e.session_id);
    else if (e.event_type === "survey_step") { const st = String(m.step || ""); if (st) { let s = stepReached.get(st); if (!s) { s = new Set(); stepReached.set(st, s); } s.add(e.session_id); } }
    else if (e.event_type === "survey_completed") {
      completed.add(e.session_id);
      for (const key of ["cups_per_day", "health_goal", "coffee_style"] as const) {
        const v = m[key] != null ? String(m[key]) : null;
        if (v) answers[key].set(v, (answers[key].get(v) || 0) + 1);
      }
    } else if (e.event_type === "lead_captured" && m.source === "survey_chapter") email.add(e.session_id);
  }
  const shownN = shown.size;
  const dist = (map: Map<string, number>) => [...map.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  return {
    shown: shownN,
    steps: ["q1", "q2", "q3", "result"].map((st) => {
      const reached = stepReached.get(st)?.size || 0;
      return { step: st, label: SURVEY_STEP_LABEL[st] || st, reached, pct_of_shown: shownN > 0 ? round1((100 * reached) / shownN) : 0 };
    }),
    completed: completed.size, email: email.size,
    answers: { cups_per_day: dist(answers.cups_per_day), health_goal: dist(answers.health_goal), coffee_style: dist(answers.coffee_style) },
  };
}
