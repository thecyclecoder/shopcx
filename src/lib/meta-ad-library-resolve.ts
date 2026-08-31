/**
 * Brand → Meta Page ID resolution (replaces the AdLibrary winners-flow advertiser lanes).
 *
 * Meta's archive has NO advertiser-name search. Every documented route is closed to us (all
 * verified 2026-08-24 against the live API with the ID-confirmed user token):
 *   • `GET /pages/search`  → code 10, needs Page Public Content Access
 *   • `GET /{vanity-handle}` → code 100, page handles don't resolve as Graph objects
 *   • `GET /search?type=page` → returns an empty set
 *
 * What DOES work is a property of the archive itself: every ad row carries `page_id` + `page_name`.
 * So we cast a wide keyword net, collect the distinct advertisers behind the results, and pick the
 * one whose NAME strictly matches the brand. Proven live: "mud wtr" → `MUD\WTR` / 172538983355501,
 * "Erth Labs" → 656545627533387.
 *
 * ⚠️ `search_terms` matches ad COPY, not advertiser name. Searching "everydaydose" returns UGC
 * affiliates and travel influencers who merely mention the brand — the top result by ad-count was a
 * completely unrelated page. That is exactly why `nameMatches` is STRICT and why "most ads" is only
 * a tiebreak AMONG name-matched candidates, never a selector on its own.
 *
 * Resolution is a repair path, not a hot path: `competitors.meta_page_id` is already populated for
 * most rows, and collection should prefer the stored id. See [[./meta-ad-library]].
 */
import { getAdLibraryToken, META_GRAPH_VERSION, DEFAULT_COUNTRIES } from "@/lib/meta-ad-library";
import { hostOf, registrableDomain } from "@/lib/competitor-ad-types";

const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

export interface AdvertiserResolution {
  /** The Meta Page ID to collect from — null when unresolved (a reliable bad seed). */
  pageId: string | null;
  /** The matched page name, for the operator to eyeball. */
  name: string | null;
  /** How many ads we saw from this page during resolution (brand-size sanity, NOT a selector). */
  adCount: number | null;
  /** How it resolved: 'name' (strict name match) | 'domain' (ads pointing at the brand's domain). */
  via: "name" | "domain" | null;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A candidate name MATCHES the brand only when their NORMALIZED forms are EQUAL, or the candidate is
 *  the brand plus ONE trailing corporate suffix. STRICT on purpose — loose matching mis-picked
 *  "Bulletproof Automotive" for "Bulletproof", "Ryze Hendricks" for "RYZE", "…Concrete Beams" for
 *  "Beam Dream". Better a known gap than a confidently-wrong Page ID feeding collection. */
const SUFFIXES = new Set(["llc", "inc", "co", "corp", "ltd", "company"]);
export function nameMatches(brand: string, candidateName: string): boolean {
  const b = norm(brand);
  const c = norm(candidateName);
  if (!b || !c) return false;
  if (b === c) return true;
  const bw = brand.toLowerCase().split(/\s+/).filter(Boolean);
  const cw = candidateName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (cw.length === bw.length + 1 && SUFFIXES.has(cw[cw.length - 1])) {
    return (
      cw.slice(0, bw.length).join(" ") === bw.map((w) => w.replace(/[^a-z0-9]/g, "")).join(" ")
    );
  }
  return false;
}

interface Candidate {
  pageId: string;
  name: string;
  ads: number;
  /** How many of this page's ads point at the brand's own domain. The domain-lane signal. */
  domainHits: number;
}

/** One wide keyword sweep → the distinct advertisers behind the results. */
async function candidatesForTerm(
  workspaceId: string,
  term: string,
  expectedDomain: string | null,
): Promise<Map<string, Candidate>> {
  const token = await getAdLibraryToken(workspaceId);
  const out = new Map<string, Candidate>();
  if (!token) return out;

  const qs = new URLSearchParams({
    access_token: token,
    search_terms: term,
    ad_reached_countries: JSON.stringify([...DEFAULT_COUNTRIES]),
    ad_type: "ALL",
    limit: "100",
    fields: "id,page_id,page_name,ad_creative_link_captions",
  });
  let url = `${GRAPH}/ads_archive?${qs}`;
  const target = expectedDomain ? registrableDomain(hostOf(expectedDomain) ?? expectedDomain) : null;

  for (let page = 0; page < 5; page++) {
    const res = await fetch(url);
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json || json.error) break;
    for (const row of ((json.data as Record<string, unknown>[]) ?? [])) {
      const pageId = row.page_id as string | undefined;
      const name = (row.page_name as string) ?? "";
      if (!pageId) continue;
      const cur = out.get(pageId) ?? { pageId, name, ads: 0, domainHits: 0 };
      cur.ads++;
      if (target) {
        const caps = JSON.stringify(row.ad_creative_link_captions ?? "").toLowerCase();
        if (caps.includes(target)) cur.domainHits++;
      }
      out.set(pageId, cur);
    }
    const next = (json.paging as { next?: string } | undefined)?.next;
    if (!next) break;
    url = next;
  }
  return out;
}

/**
 * Resolve a competitor to a Meta Page ID.
 *
 *   • `via:'name'`   — a candidate's name strictly matches the brand. Authoritative.
 *   • `via:'domain'` — no name match, but one page's ads overwhelmingly drive to the brand's own
 *                      domain. Catches brands whose Meta page name differs from the trade name.
 *   • `via:null`     — neither. A reliable bad seed; do NOT guess.
 *
 * Never throws — a fetch failure resolves to unresolved so one bad brand can't fail a sweep.
 */
export async function resolveAdvertiser(
  workspaceId: string,
  brand: string,
  opts: { domain?: string | null } = {},
): Promise<AdvertiserResolution> {
  const unresolved: AdvertiserResolution = { pageId: null, name: null, adCount: null, via: null };
  if (!brand?.trim()) return unresolved;

  try {
    const domain = opts.domain ?? null;
    // Terms worth trying, cheapest signal first. The bare domain is a strong term because Meta
    // indexes the ad's link caption, so a brand's own ads surface even when the page name differs.
    const terms = [brand, ...(domain ? [registrableDomain(hostOf(domain) ?? domain)] : [])];

    const merged = new Map<string, Candidate>();
    for (const term of terms) {
      const found = await candidatesForTerm(workspaceId, term, domain);
      for (const [id, c] of found) {
        const cur = merged.get(id);
        if (cur) {
          cur.ads += c.ads;
          cur.domainHits += c.domainHits;
        } else {
          merged.set(id, { ...c });
        }
      }
    }
    const all = [...merged.values()];
    if (!all.length) return unresolved;

    // LANE A — strict name match. Tiebreak by ad count only among matches.
    const named = all.filter((c) => nameMatches(brand, c.name)).sort((a, b) => b.ads - a.ads);
    if (named[0]) {
      return { pageId: named[0].pageId, name: named[0].name, adCount: named[0].ads, via: "name" };
    }

    // LANE B — domain lane. Require a MEANINGFUL majority of the page's ads to point at the
    // brand's domain, so an affiliate that ran two of the brand's links doesn't get promoted to
    // "the brand". Erth's affiliate network is exactly this hazard: Holistic Health Finds ran 30
    // erthlabs-pointing ads but is NOT Erth.
    if (domain) {
      const byDomain = all
        .filter((c) => c.domainHits >= 3 && c.domainHits / Math.max(1, c.ads) >= 0.8)
        .sort((a, b) => b.domainHits - a.domainHits);
      if (byDomain[0]) {
        return {
          pageId: byDomain[0].pageId,
          name: byDomain[0].name,
          adCount: byDomain[0].ads,
          via: "domain",
        };
      }
    }
    return unresolved;
  } catch {
    return unresolved;
  }
}

/**
 * Discover the AFFILIATE pages fronting a brand — pages that aren't the brand but push its traffic.
 *
 * Erth runs 110 ads across 7 pages; only 79 are on the brand page. The rest are persona/advertorial
 * pages ("Holistic Health Finds", "The Root & Remedy Club", "Sandra Taylor") whose creative uses a
 * visibly different angle — problem-first hooks where the brand page runs pure offer. That is real
 * competitive intelligence the brand-page-only view misses entirely.
 *
 * Returns pages EXCLUDING the brand's own page, ordered by how many brand-pointing ads they run.
 */
export async function discoverAffiliatePages(
  workspaceId: string,
  brand: string,
  domain: string,
  opts: { excludePageId?: string | null; minAds?: number } = {},
): Promise<Array<{ pageId: string; name: string; ads: number }>> {
  const target = registrableDomain(hostOf(domain) ?? domain);
  const minAds = opts.minAds ?? 2;
  const merged = new Map<string, Candidate>();
  for (const term of [brand, target]) {
    for (const [id, c] of await candidatesForTerm(workspaceId, term, domain)) {
      const cur = merged.get(id);
      if (cur) {
        cur.ads += c.ads;
        cur.domainHits += c.domainHits;
      } else merged.set(id, { ...c });
    }
  }
  return [...merged.values()]
    .filter((c) => c.pageId !== opts.excludePageId && c.domainHits >= minAds)
    .sort((a, b) => b.domainHits - a.domainHits)
    .map((c) => ({ pageId: c.pageId, name: c.name, ads: c.domainHits }));
}
