/**
 * AdLibrary WINNERS flow (winners-flow Phase 1 — advertiser resolution).
 *
 * The keyword `searchAds` endpoint ([[./adlibrary]]) only returns RECENT ads, not a brand's proven
 * long-running winners. The winning ads live behind the ADVERTISER endpoints:
 *   1. `GET /api/advertisers/search?q={brand}`  (free)  → resolve brand → Meta Page ID.
 *   2. `POST /api/winners/advertiser/{pageId}`   (10cr) → scan the FULL library, score + tag winners.
 *
 * This module owns step 1 — `resolveAdvertiser(brand, { domain })` — with the two lessons battle-tested
 * against the live API (2026-07-17):
 *   • Don't trust `best_match` blindly: it picked "Mud Wtr Wellness" (0 likes) over the real 124K-like
 *     "MUD\WTR". We pick the HIGHEST-LIKES candidate whose normalized name matches the brand.
 *   • Some brands don't resolve by name at all (Beam, Wellah). Their ads ARE findable by DOMAIN
 *     (`/api/search?domain=shopbeam.com` → 60 ads). We fall back to a domain search and lift the dominant
 *     `page_id` off the returned ads — so domain-only brands still yield a Page ID for the winners scan.
 *
 * A brand that resolves to neither is a RELIABLE bad seed (unlike the old 0-ads flag).
 */

const ADLIBRARY_BASE = process.env.ADLIBRARY_BASE || "https://adlibrary.com";
const ADLIBRARY_API_KEY = process.env.ADLIBRARY_API_KEY;

export interface AdvertiserResolution {
  /** The Meta advertiser Page ID for the winners scan — null when unresolved (bad/ambiguous seed). */
  pageId: string | null;
  /** The matched page name (for the operator to eyeball) + its like count (brand-size sanity). */
  name: string | null;
  likes: number | null;
  /** How it resolved: 'name' (advertisers/search) | 'domain' (/api/search?domain=) | null. */
  via: "name" | "domain" | null;
}

interface MetaCandidate {
  id: string;
  name: string;
  likes?: number | null;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A candidate name MATCHES the brand when one normalized string contains the other, or they share a
 *  significant (>2-char) token. Loose enough for "MUD\WTR" vs "MUD WTR", strict enough that the caller's
 *  likes-ranking then rejects the substring-collision big pages ("trip" ⊂ "Triple H"). */
export function nameMatches(brand: string, candidateName: string): boolean {
  const b = norm(brand);
  const c = norm(candidateName);
  if (!b || !c) return false;
  if (c.includes(b) || b.includes(c)) return true;
  const bw = brand.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const cw = candidateName.toLowerCase().split(/\s+/);
  return bw.some((w) => cw.includes(w));
}

/** Pure ranker — highest-likes candidate whose name matches the brand (the MUD\WTR fix). Exported for tests. */
export function pickBestCandidate(brand: string, candidates: MetaCandidate[]): MetaCandidate | null {
  return (
    candidates
      .filter((c) => c && c.id && nameMatches(brand, c.name))
      .sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0))[0] ?? null
  );
}

async function resolveByName(brand: string): Promise<AdvertiserResolution | null> {
  const res = await fetch(`${ADLIBRARY_BASE}/api/advertisers/search?q=${encodeURIComponent(brand)}&country=US`, {
    headers: { Authorization: `Bearer ${ADLIBRARY_API_KEY}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { best_match?: { meta?: MetaCandidate }; candidates?: { meta?: MetaCandidate[] } };
  const all: MetaCandidate[] = [...(json.best_match?.meta ? [json.best_match.meta] : []), ...(json.candidates?.meta ?? [])];
  const m = pickBestCandidate(brand, all);
  return m ? { pageId: m.id, name: m.name, likes: m.likes ?? null, via: "name" } : null;
}

async function resolveByDomain(domain: string): Promise<AdvertiserResolution | null> {
  // /api/search accepts an (undocumented) `domain` filter; the returned ads carry `page_id` — lift the
  // DOMINANT page_id (most-common) as the advertiser. Verified live: shopbeam.com → 60 Beam ads.
  const res = await fetch(`${ADLIBRARY_BASE}/api/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADLIBRARY_API_KEY}` },
    body: JSON.stringify({ appType: "3", geo: ["USA"], domain, pageSize: 50 }),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as Record<string, unknown>;
  const rows = ((json.data as Record<string, unknown>[]) || (json.list as Record<string, unknown>[]) || []) as Array<{
    page_id?: string;
    page_name?: string;
    advertiser_name?: string;
  }>;
  if (!rows.length) return null;
  const counts = new Map<string, { count: number; name: string }>();
  for (const r of rows) {
    if (!r.page_id) continue;
    const e = counts.get(r.page_id) ?? { count: 0, name: r.page_name || r.advertiser_name || "" };
    e.count += 1;
    counts.set(r.page_id, e);
  }
  const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count)[0];
  return top ? { pageId: top[0], name: top[1].name || null, likes: null, via: "domain" } : null;
}

/**
 * Resolve a competitor to a Meta advertiser Page ID: brand-name resolve first (highest-likes name match),
 * then a DOMAIN fallback when a domain is known and the name didn't resolve. Returns `{pageId:null, via:null}`
 * when neither works — the caller treats that as a bad/ambiguous seed. Never throws (a fetch failure → null).
 */
export async function resolveAdvertiser(
  brand: string,
  opts: { domain?: string | null } = {},
): Promise<AdvertiserResolution> {
  if (!ADLIBRARY_API_KEY) return { pageId: null, name: null, likes: null, via: null };
  try {
    const byName = await resolveByName(brand);
    if (byName?.pageId) return byName;
  } catch {
    /* fall through to domain */
  }
  if (opts.domain) {
    try {
      const byDomain = await resolveByDomain(opts.domain);
      if (byDomain?.pageId) return byDomain;
    } catch {
      /* unresolved */
    }
  }
  return { pageId: null, name: null, likes: null, via: null };
}
