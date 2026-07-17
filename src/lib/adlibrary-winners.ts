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

/** A candidate name MATCHES the brand only when their NORMALIZED forms are EQUAL, OR the candidate is the
 *  brand plus a trailing corporate/category suffix (`llc`/`inc`/`co`/`nutrition`/…). STRICT on purpose:
 *  the loose token/substring matching mis-picked "Bulletproof Automotive" for "Bulletproof", "Ryze
 *  Hendricks" for "RYZE", "…Concrete Beams" for "Beam Dream", and "Live Update Pvt Ltd" for "Live it Up".
 *  A brand that doesn't strictly match is routed to the domain lane / left unresolved (correct — better a
 *  known gap than a confidently-wrong Page ID feeding the winners scan). The operator's curated
 *  `search_keyword` is expected to be the brand AS IT APPEARS on Meta (e.g. "RYZE Superfoods"). */
const SUFFIXES = new Set(["llc", "inc", "co", "corp", "ltd", "company"]);
export function nameMatches(brand: string, candidateName: string): boolean {
  const b = norm(brand);
  const c = norm(candidateName);
  if (!b || !c) return false;
  if (b === c) return true;
  // candidate = brand + a single trailing corporate suffix token (word-level), e.g. "Vital Proteins" ~
  // "Vital Proteins LLC". Word-boundary check so "beam" never matches "…Concrete Beams".
  const bw = brand.toLowerCase().split(/\s+/).filter(Boolean);
  const cw = candidateName.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  if (cw.length === bw.length + 1 && SUFFIXES.has(cw[cw.length - 1])) {
    return cw.slice(0, bw.length).join(" ") === bw.map((w) => w.replace(/[^a-z0-9]/g, "")).join(" ");
  }
  return false;
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

/**
 * Resolve a competitor to a collection LANE:
 *   • `via:'name'` + `pageId`  → LANE A: the winners scan (`scanWinners`) — AdLibrary's AI-scored concepts.
 *   • `via:'domain'` (pageId null, a domain is known) → LANE B: domain search (`collectDomainAds`) — the
 *     brand's real ads with OUR vision breakdown. AdLibrary genuinely can't map these advertisers, so the
 *     winners endpoint isn't available; a `domain:` search DOES return their ads (but with no page_id).
 *   • `via:null` (no name match, no domain) → UNRESOLVED = a reliable bad seed.
 * Never throws (a fetch failure → unresolved). The strict `nameMatches` prevents a confidently-wrong pageId.
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
    /* fall through */
  }
  // No strict name→pageId. If we know a domain, this competitor is LANE B (domain search + our vision).
  if (opts.domain) return { pageId: null, name: null, likes: null, via: "domain" };
  return { pageId: null, name: null, likes: null, via: null };
}

// ── LANE A: winners scan ─────────────────────────────────────────────────────
/** One scored winner CONCEPT from `/api/winners/advertiser/{pageId}` — the ad + AdLibrary's AI breakdown. */
export interface WinnerConcept {
  ad: Record<string, unknown>;
  tier: string | null; // high_confidence_winner | winner | middle | loser | emerging
  composite: number | null;
  variantCount: number | null;
  /** AdLibrary's concept tags — the rubric our LANE-B vision must mirror. */
  tags: {
    angle?: string;
    format?: string;
    archetype?: string;
    why_it_works?: string;
    cialdini_lever?: string;
    awareness_stage?: string;
  } | null;
}

/**
 * Scan a Meta advertiser's FULL library for scored, concept-tagged winners (LANE A). Handles BOTH response
 * shapes seen live: a cached run returns `{ summary, results:[{ad,score}] }` JSON; a fresh run streams NDJSON
 * (`{_stage:'score', ad, score}` lines). Filters to `static_image` (we don't do video). 10 credits (cached: 0).
 */
export async function scanWinners(
  pageId: string,
  opts: { country?: string; topEnrich?: number; maxPages?: number } = {},
): Promise<WinnerConcept[]> {
  if (!ADLIBRARY_API_KEY) return [];
  const res = await fetch(`${ADLIBRARY_BASE}/api/winners/advertiser/${encodeURIComponent(pageId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADLIBRARY_API_KEY}` },
    body: JSON.stringify({
      country: opts.country ?? "US",
      ...(opts.topEnrich ? { top_enrich: opts.topEnrich } : {}),
      ...(opts.maxPages ? { max_pages: opts.maxPages } : {}),
    }),
  });
  if (!res.ok) return [];
  const text = await res.text();
  const scored: Array<{ ad: Record<string, unknown>; score: Record<string, unknown> }> = [];
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.includes('"results"') && !trimmed.includes("\n{")) {
    // cached JSON shape
    try {
      const j = JSON.parse(trimmed) as { results?: Array<{ ad: Record<string, unknown>; score: Record<string, unknown> }> };
      for (const r of j.results ?? []) if (r?.ad && r?.score) scored.push(r);
    } catch {
      /* ignore */
    }
  } else {
    // NDJSON stream
    for (const line of trimmed.split("\n")) {
      try {
        const o = JSON.parse(line) as { _stage?: string; ad?: Record<string, unknown>; score?: Record<string, unknown> };
        if (o._stage === "score" && o.ad && o.score) scored.push({ ad: o.ad, score: o.score });
      } catch {
        /* skip non-JSON line */
      }
    }
  }
  return scored
    .map((r): WinnerConcept => {
      const s = r.score as { tier?: string; composite?: number; variant_count?: number; tags?: WinnerConcept["tags"] };
      return {
        ad: r.ad,
        tier: s.tier ?? null,
        composite: typeof s.composite === "number" ? s.composite : null,
        variantCount: typeof s.variant_count === "number" ? s.variant_count : null,
        tags: s.tags ?? null,
      };
    })
    .filter((c) => (c.tags?.format ? c.tags.format === "static_image" : true)); // image-only
}
