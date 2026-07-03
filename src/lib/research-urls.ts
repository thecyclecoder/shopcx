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
 * filters a JUNK_DOMAINS skiplist (linkedin.com + obvious non-commerce / lead-gen), and upserts rows as
 * teardown_verdict='unreviewed'. Idempotent — re-running does NOT duplicate rows (the UNIQUE(workspace_id,
 * url) plus upsert holds).
 */
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Junk / non-commerce destinations we deliberately drop at sync time — they aren't landers we would
 * ever teardown. Kept small and obvious; a real 'spam' verdict is Phase 2's call (Rhea classifies).
 */
const JUNK_DOMAINS: readonly string[] = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "tiktok.com",
  "youtube.com",
  "youtu.be",
  "pinterest.com",
  "google.com",
  "apple.com",
  "play.google.com",
  "wa.me",
  "bit.ly",
];

/** classification vocab (matches the CHECK constraint on public.research_urls.classification). */
export type ResearchUrlClassification =
  | "advertorial"
  | "quiz"
  | "generic_pdp"
  | "homepage"
  | "spam"
  | "unviewable";

/** teardown_verdict vocab (matches the CHECK constraint). */
export type ResearchUrlVerdict = "worthy" | "not_worthy" | "unreviewed";

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
  classified_at: string | null;
  classified_by: string | null;
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

/** True when a normalized URL points at a domain (or subdomain of one) on the JUNK_DOMAINS skiplist. */
export function isJunkUrl(normalizedUrl: string): boolean {
  const host = domainOf(normalizedUrl);
  if (!host) return true;
  for (const junk of JUNK_DOMAINS) {
    if (host === junk || host.endsWith(`.${junk}`)) return true;
  }
  return false;
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
  skippedJunk: number;
  skippedNoUrl: number;
}

/**
 * Walk creative_skeletons for a workspace, dedup by normalized URL, and upsert one research_urls row
 * per distinct destination. Prefers `landing_page_url` (the FULL advertorial URL with path) over
 * `https://` + `destination_domain` (the bare host root, which often 404s) — mirrors the choice in
 * landing-page-scout.ts:96. Idempotent: re-running writes the same rows (UNIQUE(workspace_id, url)).
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
  let skippedJunk = 0;
  let skippedNoUrl = 0;

  interface Agg {
    url: string;
    domain: string;
    brand: string | null;
    ad_count: number;
    first_seen: string | null;
    last_seen: string | null;
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
    if (isJunkUrl(url)) {
      skippedJunk++;
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
      });
    }
  }

  const distinct = byUrl.size;
  if (distinct === 0) {
    return { scanned: rows.length, distinct: 0, upserted: 0, skippedJunk, skippedNoUrl };
  }

  // Upsert each row. We `onConflict:'workspace_id,url'` so re-runs update ad_count / last_seen without
  // duplicating. ignoreDuplicates=false so the count refresh actually lands.
  const payload = [...byUrl.values()].map((a) => ({
    workspace_id: workspaceId,
    url: a.url,
    domain: a.domain,
    brand: a.brand,
    source: "ad_scout",
    ad_count: a.ad_count,
    first_seen: a.first_seen,
    last_seen: a.last_seen,
    teardown_verdict: "unreviewed" as const,
  }));

  const { error: upErr } = await admin
    .from("research_urls")
    .upsert(payload, { onConflict: "workspace_id,url", ignoreDuplicates: false });
  if (upErr) throw new Error(`syncResearchUrlsFromCreatives upsert: ${upErr.message}`);

  return { scanned: rows.length, distinct, upserted: payload.length, skippedJunk, skippedNoUrl };
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
