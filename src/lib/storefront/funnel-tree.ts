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

  // ── fetch the visit-universe sessions (batched) ───────────────────────────
  const sessionIds = [...visitSessions];
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

    if (!handle) {
      // /blog landings that DIDN'T resolve to a product → first-class Blog bucket.
      // The rare blog URL whose path happens to contain a product-handle segment
      // still routes to that product above (preserves first-touch + no double-count).
      if (isBlogLanding(segments)) {
        addInto(blog, reached);
        blogHasAny = true;
      } else {
        addInto(unattributed, reached);
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
  if (!destKey) return { destination: null, availableDestinations, summary: null, chapters: [] };
  const destLevel = destVisits.get(destKey)?.level ?? "variant";

  const selected = new Set<string>();
  for (const [sid, s] of sessByDest) {
    const ok = destLevel === "pdp" ? !s.variant : destLevel === "variant" ? s.variant === destKey : s.angle === destKey;
    if (ok) selected.add(sid);
  }
  const visits = selected.size;
  const destination = { key: destKey, label: labelFor(destKey, destLevel) };
  if (visits === 0) return { destination, availableDestinations, summary: null, chapters: [] };

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
      .eq("workspace_id", workspaceId).in("event_type", ["chapter_view", "chapter_dwell", "pack_selected"])
      .gte("created_at", startIso).lte("created_at", endIso).order("id", { ascending: true }),
  );

  const chapterSessions = new Map<string, Set<string>>();
  const chapterIndex = new Map<string, number>();
  const dwell = new Map<string, { sum: number; n: number }>();
  const ctaOrigin = new Map<string, number>();
  const pricingSessions = new Set<string>();
  const packedSessions = new Set<string>();
  let jumped = 0, scrolled = 0;

  for (const e of chapEvents) {
    if (!selected.has(e.session_id)) continue;
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
  return {
    destination,
    availableDestinations,
    summary: {
      visits, reached_pricing: reachedPricing, carry_to_pricing_pct: round1((100 * reachedPricing) / visits),
      packed: packedSessions.size, close_pct: reachedPricing > 0 ? round1((100 * packedAmongPricing) / reachedPricing) : 0,
      jumped_to_pricing: jumped, scrolled_to_pricing: scrolled,
    },
    chapters,
  };
}
