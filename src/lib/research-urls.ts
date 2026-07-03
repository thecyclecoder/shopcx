/**
 * Rhea's URL sensor — the ONLY write path to public.research_urls (docs/brain/specs/rhea-url-sensor.md
 * Phase 1). One row per distinct ad-scout destination for a workspace; the sensor everything downstream
 * (Rhea's capture+classify loop in Phase 2, Cleo's gap analysis, the Content-Agent handoff) reads.
 *
 * North-star (supervisable autonomy): the sync PROPOSES rows (teardown_verdict='unreviewed'); Rhea's
 * later capture pass classifies them; an owner (Growth) reviews her verdicts. This file NEVER acts.
 *
 * Chokepoint discipline: every WRITE to research_urls goes through here via createAdminClient(). A CI
 * grep enforces no raw `.from('research_urls').insert|update|upsert` outside this file (mirrors the
 * spec's Phase-1 requirement + the pattern used by src/lib/specs-table.ts / goals-table.ts).
 *
 * Phase 1 sync: reads creative_skeletons (prefers `landing_page_url`, else `https://` + `destination_domain`),
 * joins the brand via `seed_keyword`, dedups by normalized URL, counts ads per destination into `ad_count`,
 * and upserts rows as teardown_verdict='unreviewed'. Idempotent — re-running does NOT duplicate rows
 * (the UNIQUE(workspace_id, url) plus upsert holds).
 *
 * rhea-research-automation Phase 2 — deterministic gate at sync time (`classifyNonLanderGate`):
 * a non-lander domain (social/login/app-store/aggregator/search + generic login paths) upserts
 * with `classification='excluded'` + `teardown_verdict='not_worthy'` + `classified_by='deterministic'`;
 * a checkout URL (`/checkout`, `/cart`, `checkout.` / `pay.` subdomain) upserts with
 * `classification='checkout'`. Gated rows are KEPT (auditable) but INVISIBLE to the research-sensor
 * claim (which filters `classification IS NULL`). Genuine advertorial/PDP destinations still upsert
 * `classification=null` and remain claimable.
 */
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Non-lander domains — social networks, login walls, app stores, aggregators, search engines.
 * These are KEPT (not dropped) at sync time, but pre-stamped `classification='excluded'` +
 * `teardown_verdict='not_worthy'` + `classified_by='deterministic'` so they're INVISIBLE to
 * the Phase-1 research-sensor claim (which filters on `classification IS NULL`) while remaining
 * auditable in the row. Matches host OR any subdomain (`.host` suffix). See
 * docs/brain/specs/rhea-research-automation.md Phase 2.
 */
const NON_LANDER_DOMAINS: readonly string[] = [
  // Social / community
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "pinterest.com",
  "reddit.com",
  "snapchat.com",
  "threads.net",
  // App stores
  "apps.apple.com",
  "play.google.com",
  // Link aggregators
  "linktr.ee",
  "beacons.ai",
  // Search engines
  "google.com",
  "bing.com",
];

/** Path prefixes (case-insensitive) that mark a URL as a generic login/signin wall — same treatment as non-lander domain. */
const NON_LANDER_LOGIN_PATHS: readonly string[] = ["/login", "/signin", "/sign-in", "/log-in"];

/** Subdomain prefixes (case-insensitive) that mark a URL as an account/login page — same treatment. */
const NON_LANDER_LOGIN_SUBDOMAIN_PREFIXES: readonly string[] = ["accounts."];

/** Path prefixes (case-insensitive) that mark a URL as a checkout page — `classification='checkout'`. */
const CHECKOUT_PATH_SEGMENTS: readonly string[] = ["/checkout", "/checkouts", "/cart"];

/** Subdomain prefixes (case-insensitive) that mark a URL as a checkout page — same treatment. */
const CHECKOUT_SUBDOMAIN_PREFIXES: readonly string[] = ["checkout.", "pay."];

/** classification vocab (matches the CHECK constraint on public.research_urls.classification). */
export type ResearchUrlClassification =
  | "advertorial"
  | "quiz"
  | "generic_pdp"
  | "homepage"
  | "spam"
  | "unviewable"
  | "excluded"
  | "checkout";

/** teardown_verdict vocab (matches the CHECK constraint). */
export type ResearchUrlVerdict = "worthy" | "not_worthy" | "unreviewed";

/**
 * Lever vocab for `TeardownRecipe.levers[].lever` — the tagged persuasion primitives Rhea
 * spots on a worthy lander. Union kept small on purpose (the point is a stable vocabulary
 * Cleo can gap-analyze against our storefront); extending it is a spec change.
 */
export type TeardownLever =
  | "authority"
  | "social_proof"
  | "ugc"
  | "urgency"
  | "price_anchor"
  | "risk_reversal"
  | "value_stack"
  | "objection_handling"
  | "specificity"
  | "bandwagon"
  | "choice_simplicity";

/**
 * The structured teardown of a worthy lander — the artifact Cleo (slice 3) reads to diff
 * against our storefront and emit a build blueprint. Written by `setTeardown` after Rhea's
 * one-session pass over the already-captured chapters (no re-render). See
 * docs/brain/specs/rhea-teardown-recipe.md Phase 1.
 */
export interface TeardownRecipe {
  /** Broad funnel classification (e.g. "advertorial-listicle", "quiz", "generic_pdp"). */
  funnel_type: string;
  /** One-sentence strategy summary Rhea derived from what she saw. */
  strategy: string;
  /** Ordered chapter roles top-to-bottom of the lander (hero, intro/proof, …, offer, faq). */
  architecture: { chapter_role: string; purpose: string }[];
  /** Optional emotion→logic sequence — populated for listicle-style landers. */
  reason_sequence?: {
    order: number;
    benefit: string;
    appeal: "emotion" | "logic";
    mechanism: string;
  }[];
  /** Tagged persuasion levers, each with the concrete evidence Rhea saw. */
  levers: { lever: TeardownLever; evidence: string }[];
  /** The offer chapter parsed into discrete pieces. `options` is the count of purchase paths. */
  offer: {
    discount?: string;
    bundle?: string;
    bonuses?: string[];
    guarantee?: string;
    urgency?: string;
    options: number;
  };
  /** The product-agnostic skeleton — the pattern we could transfer to a Superfoods lander. */
  transferable_pattern: string;
}

export interface ResearchUrl {
  id: string;
  workspace_id: string;
  url: string;
  domain: string;
  brand: string | null;
  competitor_id: string | null;
  source: string;
  ad_count: number;
  first_seen: string | null;
  last_seen: string | null;
  classification: ResearchUrlClassification | null;
  teardown_verdict: ResearchUrlVerdict;
  rationale: string | null;
  capture_ref: string | null;
  teardown: TeardownRecipe | null;
  classified_at: string | null;
  classified_by: string | null;
  /**
   * Cleo's review watermark (rhea-research-automation Phase 3). Null until Growth (Cleo) has
   * read the row's teardown recipe and stamped it via `markTeardownReviewed`. `listNewTeardowns`
   * returns only rows where this is null — the discovery surface Cleo polls for NEW findings.
   */
  growth_reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResearchUrlFilter {
  domain?: string;
  brand?: string;
  classification?: ResearchUrlClassification;
  teardown_verdict?: ResearchUrlVerdict;
  competitor_id?: string;
  limit?: number;
}

// ── URL normalization ──────────────────────────────────────────────────────────

/**
 * Normalize a URL to the de-dup key we store on research_urls.url. Preserves the path (an
 * advertorial slug is the signal — see landing-page-scout.ts:96) but strips the tracking query
 * string, hash, and lower-cases the host. Returns null on any parse failure.
 */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withScheme);
    u.hash = "";
    u.search = "";
    u.hostname = u.hostname.toLowerCase();
    // Strip a lone trailing slash on paths deeper than '/' so '/foo/' == '/foo'.
    let out = u.toString();
    if (u.pathname.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
    return out;
  } catch {
    return null;
  }
}

function domainOf(normalizedUrl: string): string | null {
  try {
    return new URL(normalizedUrl).hostname;
  } catch {
    return null;
  }
}

/**
 * Deterministic gate applied at sync time (rhea-research-automation Phase 2). Two verdicts:
 *   • 'excluded' — non-lander domain (social/login/app-store/aggregator/search) OR a generic
 *     login/signin path or `accounts.` subdomain. Never a lander we would teardown.
 *   • 'checkout' — checkout / cart page, either by URL path or `checkout.` / `pay.` subdomain.
 *     Out of scope for the lander teardown pipeline (a separate feature will own checkout gaps).
 *   • null      — passes the gate; a genuine advertorial/PDP that Rhea will classify later.
 *
 * The sync KEEPS these rows and pre-stamps them so they're INVISIBLE to the research-sensor
 * claim (which filters `classification IS NULL`) while remaining kept + auditable. Returns null
 * when the URL host can't be parsed — the sync treats that as skippedNoUrl (upstream), never
 * gated (we can't safely stamp a rationale for a URL we don't understand).
 */
export function classifyNonLanderGate(normalizedUrl: string): {
  classification: "excluded" | "checkout";
  rationale: string;
} | null {
  const host = domainOf(normalizedUrl);
  if (!host) return null;
  const lowerHost = host.toLowerCase();

  // Checkout subdomain (checkout. / pay.) wins first — a `checkout.brand.com` should be `checkout`,
  // not `excluded`, even if its parent were on the non-lander list (it wouldn't be, but be safe).
  for (const prefix of CHECKOUT_SUBDOMAIN_PREFIXES) {
    if (lowerHost.startsWith(prefix)) {
      return { classification: "checkout", rationale: "checkout page — out of scope (separate feature)" };
    }
  }

  // Non-lander domain (host === list or host endsWith .list). Includes app stores + aggregators.
  for (const domain of NON_LANDER_DOMAINS) {
    if (lowerHost === domain || lowerHost.endsWith(`.${domain}`)) {
      return {
        classification: "excluded",
        rationale: "non-lander domain (social/login/app-store/aggregator)",
      };
    }
  }

  // Generic account/login subdomain (e.g. accounts.google.com would be caught above, but
  // accounts.brand.com is also a login wall).
  for (const prefix of NON_LANDER_LOGIN_SUBDOMAIN_PREFIXES) {
    if (lowerHost.startsWith(prefix)) {
      return {
        classification: "excluded",
        rationale: "non-lander domain (social/login/app-store/aggregator)",
      };
    }
  }

  // URL-path checks — parse fresh so we get the *actual* pathname (lowercase, from URL).
  let path = "";
  try {
    path = new URL(normalizedUrl).pathname.toLowerCase();
  } catch {
    return null;
  }
  for (const seg of CHECKOUT_PATH_SEGMENTS) {
    if (path === seg || path.startsWith(`${seg}/`)) {
      return { classification: "checkout", rationale: "checkout page — out of scope (separate feature)" };
    }
  }
  for (const seg of NON_LANDER_LOGIN_PATHS) {
    if (path === seg || path.startsWith(`${seg}/`)) {
      return {
        classification: "excluded",
        rationale: "non-lander domain (social/login/app-store/aggregator)",
      };
    }
  }
  return null;
}

/**
 * @deprecated Kept for callers outside the sync path. Prefer `classifyNonLanderGate` — the sync
 * itself no longer DROPS junk URLs; it KEEPS them with `classification='excluded'`. A `true`
 * return here means the URL would be gated as 'excluded' or 'checkout'.
 */
export function isJunkUrl(normalizedUrl: string): boolean {
  return classifyNonLanderGate(normalizedUrl) !== null;
}

// ── Sync from the ad scout (creative_skeletons → research_urls) ───────────────

interface CreativeSkeletonSlice {
  landing_page_url: string | null;
  destination_domain: string | null;
  seed_keyword: string | null;
  first_seen: string | null;
  last_seen: string | null;
}

export interface SyncResearchUrlsResult {
  scanned: number;
  distinct: number;
  upserted: number;
  /**
   * Rows KEPT but pre-stamped `classification='excluded'` by the deterministic gate — social /
   * login / app-store / aggregator / search / generic login-path URLs. They upsert like any other
   * row but stay INVISIBLE to the research-sensor claim (`classification IS NULL`). Was
   * `skippedJunk` in Phase 1; the sync no longer drops these — it audits them.
   */
  gatedExcluded: number;
  /** Rows KEPT but pre-stamped `classification='checkout'` — checkout/cart URLs, out of scope. */
  gatedCheckout: number;
  /** @deprecated alias for `gatedExcluded + gatedCheckout` — legacy callers may still read it. */
  skippedJunk: number;
  skippedNoUrl: number;
}

/**
 * Walk creative_skeletons for a workspace, dedup by normalized URL, and upsert one research_urls row
 * per distinct destination. Prefers `landing_page_url` (the FULL advertorial URL with path) over
 * `https://` + `destination_domain` (the bare host root, which often 404s) — mirrors the choice in
 * landing-page-scout.ts:96. Idempotent: re-running writes the same rows (UNIQUE(workspace_id, url)).
 *
 * rhea-research-automation Phase 2 — deterministic gate: as each destination is prepared for
 * upsert, `classifyNonLanderGate` may pre-stamp it as `classification='excluded'` (non-lander
 * domain or generic login) or `classification='checkout'`. Gated rows are UPSERTED (kept +
 * auditable) but invisible to the sensor's claim query, so the box never chases a lander that
 * isn't one and never captures a checkout page here.
 */
export async function syncResearchUrlsFromCreatives(workspaceId: string): Promise<SyncResearchUrlsResult> {
  const admin = createAdminClient();

  // Read every creative_skeleton for the workspace (analyzed or otherwise — a video_pending row still
  // carries a destination). Ordered oldest-first so `first_seen`/`last_seen` collapse cleanly.
  const { data, error } = await admin
    .from("creative_skeletons")
    .select("landing_page_url, destination_domain, seed_keyword, first_seen, last_seen")
    .eq("workspace_id", workspaceId)
    .order("first_seen", { ascending: true })
    .limit(5000);
  if (error) throw new Error(`syncResearchUrlsFromCreatives read: ${error.message}`);

  const rows = (data || []) as CreativeSkeletonSlice[];
  let skippedNoUrl = 0;

  interface Agg {
    url: string;
    domain: string;
    brand: string | null;
    ad_count: number;
    first_seen: string | null;
    last_seen: string | null;
    /** null = passes the gate; a genuine advertorial/PDP candidate. */
    gate: ReturnType<typeof classifyNonLanderGate>;
  }
  const byUrl = new Map<string, Agg>();

  for (const r of rows) {
    // Prefer the FULL landing_page_url (advertorial slug, e.g. …/women50) over the bare host — a
    // bare-host root often 404s ([[landing-page-scout]] adDestinationsForBrand comment).
    const candidate = r.landing_page_url && r.landing_page_url.trim()
      ? r.landing_page_url
      : r.destination_domain && r.destination_domain.trim()
      ? `https://${r.destination_domain.replace(/^https?:\/\//i, "").trim()}`
      : null;

    if (!candidate) {
      skippedNoUrl++;
      continue;
    }
    const url = normalizeUrl(candidate);
    if (!url) {
      skippedNoUrl++;
      continue;
    }
    const domain = domainOf(url);
    if (!domain) {
      skippedNoUrl++;
      continue;
    }

    const cur = byUrl.get(url);
    if (cur) {
      cur.ad_count++;
      if (r.first_seen && (!cur.first_seen || r.first_seen < cur.first_seen)) cur.first_seen = r.first_seen;
      if (r.last_seen && (!cur.last_seen || r.last_seen > cur.last_seen)) cur.last_seen = r.last_seen;
      // First non-null seed_keyword wins as the brand — good enough for Phase 1.
      if (!cur.brand && r.seed_keyword) cur.brand = r.seed_keyword;
    } else {
      byUrl.set(url, {
        url,
        domain,
        brand: r.seed_keyword || null,
        ad_count: 1,
        first_seen: r.first_seen,
        last_seen: r.last_seen,
        gate: classifyNonLanderGate(url),
      });
    }
  }

  const distinct = byUrl.size;
  let gatedExcluded = 0;
  let gatedCheckout = 0;
  if (distinct === 0) {
    return {
      scanned: rows.length,
      distinct: 0,
      upserted: 0,
      gatedExcluded: 0,
      gatedCheckout: 0,
      skippedJunk: 0,
      skippedNoUrl,
    };
  }

  // Upsert each row. We `onConflict:'workspace_id,url'` so re-runs update ad_count / last_seen without
  // duplicating. ignoreDuplicates=false so the count refresh actually lands. Gated rows are
  // pre-stamped with classification + teardown_verdict + rationale + classified_by so they're
  // INVISIBLE to the research-sensor claim (`classification IS NULL`).
  const nowIso = new Date().toISOString();

  // CRITICAL — never clobber Rhea's classification work on a re-sync. The old code upserted a MIXED
  // payload (gated rows carry classification/verdict/…, ungated rows don't), so Supabase built ONE
  // `ON CONFLICT DO UPDATE` across the UNION of columns — resetting classification→NULL and
  // teardown_verdict→'unreviewed' on EVERY existing row each sync, silently erasing her judgments and
  // leaving only the orphaned teardown jsonb. Fix: INSERT only NEW urls; for EXISTING rows refresh
  // ONLY the volatile ad-signal (ad_count/last_seen). classification/verdict/teardown/rationale/
  // classified_* are Rhea-owned and MUST survive a re-sync.
  const aggs = [...byUrl.values()];
  for (const a of aggs) {
    if (a.gate) { if (a.gate.classification === "excluded") gatedExcluded++; else gatedCheckout++; }
  }

  const { data: existingRows, error: exErr } = await admin
    .from("research_urls")
    .select("url")
    .eq("workspace_id", workspaceId);
  if (exErr) throw new Error(`syncResearchUrlsFromCreatives read-existing: ${exErr.message}`);
  const existing = new Set((existingRows || []).map((r) => (r as { url: string }).url));

  const newRows = aggs
    .filter((a) => !existing.has(a.url))
    .map((a) => {
      const base = {
        workspace_id: workspaceId,
        url: a.url,
        domain: a.domain,
        brand: a.brand,
        source: "ad_scout",
        ad_count: a.ad_count,
        first_seen: a.first_seen,
        last_seen: a.last_seen,
      };
      return a.gate
        ? {
            ...base,
            classification: a.gate.classification,
            teardown_verdict: "not_worthy" as const,
            rationale: a.gate.rationale,
            classified_by: "deterministic",
            classified_at: nowIso,
          }
        : { ...base, teardown_verdict: "unreviewed" as const };
    });
  if (newRows.length) {
    const { error: insErr } = await admin.from("research_urls").insert(newRows);
    if (insErr) throw new Error(`syncResearchUrlsFromCreatives insert: ${insErr.message}`);
  }

  // Refresh the volatile ad-signal on EXISTING rows only — never their classification/verdict.
  let refreshed = 0;
  for (const a of aggs) {
    if (!existing.has(a.url)) continue;
    const { error: uErr } = await admin
      .from("research_urls")
      .update({ ad_count: a.ad_count, last_seen: a.last_seen, updated_at: nowIso })
      .eq("workspace_id", workspaceId)
      .eq("url", a.url);
    if (!uErr) refreshed++;
  }

  return {
    scanned: rows.length,
    distinct,
    upserted: newRows.length + refreshed,
    gatedExcluded,
    gatedCheckout,
    skippedJunk: gatedExcluded + gatedCheckout,
    skippedNoUrl,
  };
}

// ── Read + narrow-write helpers ──────────────────────────────────────────────

/** List a workspace's research_urls, optionally filtered by domain / brand / classification / verdict. */
export async function listResearchUrls(
  workspaceId: string,
  filter: ResearchUrlFilter = {},
): Promise<ResearchUrl[]> {
  const admin = createAdminClient();
  let q = admin.from("research_urls").select("*").eq("workspace_id", workspaceId);
  if (filter.domain) q = q.eq("domain", filter.domain);
  if (filter.brand) q = q.eq("brand", filter.brand);
  if (filter.classification) q = q.eq("classification", filter.classification);
  if (filter.teardown_verdict) q = q.eq("teardown_verdict", filter.teardown_verdict);
  if (filter.competitor_id) q = q.eq("competitor_id", filter.competitor_id);
  q = q.order("ad_count", { ascending: false }).limit(filter.limit ?? 500);
  const { data, error } = await q;
  if (error) throw new Error(`listResearchUrls: ${error.message}`);
  return (data || []) as ResearchUrl[];
}

/** Rhea's classify write (Phase 2 driver). Stamps classification + classified_at + classified_by. */
export async function setUrlClassification(
  workspaceId: string,
  id: string,
  classification: ResearchUrlClassification,
  classifiedBy: string = "rhea",
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("research_urls")
    .update({
      classification,
      classified_at: new Date().toISOString(),
      classified_by: classifiedBy,
    })
    .eq("id", id)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`setUrlClassification: ${error.message}`);
}

/** Rhea's teardown-verdict write. `rationale` is required for worthy/not_worthy; unreviewed accepts null. */
export async function setTeardownVerdict(
  workspaceId: string,
  id: string,
  verdict: ResearchUrlVerdict,
  rationale: string | null,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("research_urls")
    .update({ teardown_verdict: verdict, rationale })
    .eq("id", id)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`setTeardownVerdict: ${error.message}`);
}

/**
 * Rhea's capture pointer write (Phase 2). Stamps the storage-path prefix into the private
 * `research-shots` bucket where the captured chapters live — the box lane calls this after a
 * successful capture so the manifest can be re-opened later.
 */
export async function setCaptureRef(workspaceId: string, id: string, captureRef: string): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("research_urls")
    .update({ capture_ref: captureRef })
    .eq("id", id)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`setCaptureRef: ${error.message}`);
}

/** Lever vocab guard — kept next to the write so the validator can reject typos. */
const TEARDOWN_LEVERS: readonly TeardownLever[] = [
  "authority",
  "social_proof",
  "ugc",
  "urgency",
  "price_anchor",
  "risk_reversal",
  "value_stack",
  "objection_handling",
  "specificity",
  "bandwagon",
  "choice_simplicity",
];

/**
 * Validate a `TeardownRecipe` before it hits the row. Mirrors the author-spec gate discipline:
 * a half-formed recipe (empty architecture / levers / transferable_pattern, or a lever tag
 * outside the vocabulary) is REJECTED here — the SDK is the only write path, so this is where
 * we keep the artifact honest. Throws on any failure; returns void on pass.
 */
export function validateTeardownRecipe(recipe: TeardownRecipe): void {
  if (!recipe || typeof recipe !== "object") {
    throw new Error("setTeardown: recipe must be an object");
  }
  if (!recipe.funnel_type || typeof recipe.funnel_type !== "string") {
    throw new Error("setTeardown: recipe.funnel_type is required");
  }
  if (!recipe.strategy || typeof recipe.strategy !== "string") {
    throw new Error("setTeardown: recipe.strategy is required");
  }
  if (!Array.isArray(recipe.architecture) || recipe.architecture.length === 0) {
    throw new Error("setTeardown: recipe.architecture must be a non-empty array");
  }
  for (const chapter of recipe.architecture) {
    if (!chapter || !chapter.chapter_role || !chapter.purpose) {
      throw new Error("setTeardown: every architecture entry needs chapter_role + purpose");
    }
  }
  if (!Array.isArray(recipe.levers) || recipe.levers.length === 0) {
    throw new Error("setTeardown: recipe.levers must be a non-empty array");
  }
  for (const lever of recipe.levers) {
    if (!lever || !lever.evidence) {
      throw new Error("setTeardown: every lever entry needs evidence");
    }
    if (!TEARDOWN_LEVERS.includes(lever.lever)) {
      throw new Error(`setTeardown: unknown lever '${lever.lever}'`);
    }
  }
  if (recipe.reason_sequence !== undefined) {
    if (!Array.isArray(recipe.reason_sequence)) {
      throw new Error("setTeardown: recipe.reason_sequence must be an array when present");
    }
    for (const item of recipe.reason_sequence) {
      if (
        !item
        || typeof item.order !== "number"
        || !item.benefit
        || (item.appeal !== "emotion" && item.appeal !== "logic")
        || !item.mechanism
      ) {
        throw new Error(
          "setTeardown: every reason_sequence entry needs order + benefit + appeal ∈ emotion|logic + mechanism",
        );
      }
    }
  }
  if (!recipe.offer || typeof recipe.offer !== "object") {
    throw new Error("setTeardown: recipe.offer is required");
  }
  if (typeof recipe.offer.options !== "number" || recipe.offer.options < 1) {
    throw new Error("setTeardown: recipe.offer.options must be a positive number");
  }
  if (!recipe.transferable_pattern || typeof recipe.transferable_pattern !== "string") {
    throw new Error("setTeardown: recipe.transferable_pattern is required");
  }
}

/**
 * Rhea's teardown-recipe write (Phase 2 driver). Validates the recipe (rejects a half-formed
 * one with no architecture / levers / transferable_pattern — same gate discipline as author-spec)
 * then persists it to `research_urls.teardown` via the admin client. The ONLY write path for the
 * teardown column.
 */
export async function setTeardown(
  workspaceId: string,
  id: string,
  recipe: TeardownRecipe,
): Promise<void> {
  validateTeardownRecipe(recipe);
  const admin = createAdminClient();
  const { error } = await admin
    .from("research_urls")
    .update({ teardown: recipe })
    .eq("id", id)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`setTeardown: ${error.message}`);
}

// ── Cleo handoff (rhea-research-automation Phase 3) ──────────────────────────

/**
 * Cleo's DISCOVERY reader — the input trigger for the slice-4 gap-analysis loop. Returns rows
 * where Rhea has already landed a structured `teardown` recipe AND Cleo (Growth) hasn't yet
 * stamped `growth_reviewed_at`. Ordered `ad_count` DESC — the highest-spend competitor funnels
 * surface first, so Cleo's attention rides the same "spend = importance" signal the
 * research-sensor claim uses. Naturally EXCLUDES `excluded` / `checkout` / `not_worthy` /
 * `unviewable` rows because none of them carry a teardown (the recipe is worthy-only per
 * validateTeardownRecipe + the box lane's write-guard).
 *
 * Read-only. All-workspace-scoped. Bounded by `limit` (default 50 — the panel size Cleo can
 * usefully triage per poll).
 */
export async function listNewTeardowns(
  workspaceId: string,
  limit = 50,
): Promise<ResearchUrl[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("research_urls")
    .select("*")
    .eq("workspace_id", workspaceId)
    .not("teardown", "is", null)
    .is("growth_reviewed_at", null)
    .order("ad_count", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listNewTeardowns: ${error.message}`);
  return (data || []) as ResearchUrl[];
}

/**
 * Cleo's watermark stamp — the chokepoint write that drops a teardown out of `listNewTeardowns`.
 * Called once per row Cleo has consumed into her gap-analysis (slice 4). Idempotent — a second
 * call is a no-op update (the watermark simply re-advances to `now()`, which the discovery
 * reader still filters out identically).
 */
export async function markTeardownReviewed(
  workspaceId: string,
  id: string,
): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin
    .from("research_urls")
    .update({ growth_reviewed_at: new Date().toISOString() })
    .eq("id", id)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`markTeardownReviewed: ${error.message}`);
}
