/**
 * angle-demand-sweep — the chokepoint SDK that turns an (ingredient, problem-lane) pair into a
 * search-demand score used to select product_angle_palette rows. Callers stay blind to whether
 * the score came from product_seo_keywords, Google Search Console, an eventual paid provider
 * (Ahrefs), or the built-in stub — that indirection is what makes a future provider swap a
 * one-file change instead of a rewrite.
 *
 * The v3 goal turns on DEMAND selecting the angle. Until this SDK exists (Phase 1 of the
 * demand-sourced-angle-sweep spec), search_demand on product_angle_palette is set by the seed
 * author's judgement and every downstream selector (compose-engine, seed-remaining-5-products,
 * auto-fan-out when the palette starves) inherits that lie.
 *
 * Read order (first hit wins):
 *   1) product_seo_keywords rows for the workspace whose keyword mentions BOTH the ingredient
 *      AND at least one problem-lane token → derive a tier from the maximum stored volume.
 *   2) The registered provider hook (default: stubProvider → tier:'medium', source:'stub').
 *
 * Phase 2 will add runSweepForProduct that uses this to draft new product_angle_palette rows and
 * refresh existing ones behind an owner-review gate. See docs/brain/tables/product_seo_keywords.md
 * and docs/brain/tables/product_angle_palette.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SearchDemand } from "./angle-palette";

type Admin = SupabaseClient;

/**
 * Tier boundaries — named constants so a later spec can tune them without a code rewrite.
 * Aligned with the "primary/secondary/long_tail" relevance bands already assigned by
 * src/lib/inngest/seo-keyword-research.ts when it writes product_seo_keywords rows.
 */
export const HIGH_MIN_VOLUME = 1000;
export const MEDIUM_MIN_VOLUME = 100;

export interface SearchDemandRecord {
  tier: SearchDemand;
  rawVolume: number | null;
  source: string;
}

export interface FetchSearchDemandInput {
  admin: Admin;
  workspaceId: string;
  ingredient: string;
  problem: string;
}

/**
 * Provider hook — the escape hatch a future spec grafts a real data source onto (Ahrefs, GSC,
 * Keyword Planner). Called only when product_seo_keywords has no matching row for the ingredient
 * × problem pair.
 */
export type SearchDemandProvider = (input: {
  workspaceId: string;
  ingredient: string;
  problem: string;
}) => Promise<SearchDemandRecord>;

/** The built-in stub — returns medium so a demand-blind lane doesn't accidentally score high. */
export const stubProvider: SearchDemandProvider = async () => ({
  tier: "medium",
  rawVolume: null,
  source: "stub",
});

let activeProvider: SearchDemandProvider = stubProvider;

/** Swap the provider (test seams + a future paid-source spec). */
export function setSearchDemandProvider(p: SearchDemandProvider): void {
  activeProvider = p;
}

/** Reset to the stub — used by tests. */
export function resetSearchDemandProvider(): void {
  activeProvider = stubProvider;
}

/**
 * Derive a demand tier from a raw volume (monthly searches + search-console impressions summed
 * per keyword row, then max'd across matching rows).
 */
export function tierForVolume(volume: number): SearchDemand {
  if (volume >= HIGH_MIN_VOLUME) return "high";
  if (volume >= MEDIUM_MIN_VOLUME) return "medium";
  return "low";
}

/**
 * Split a problem string into lowercase tokens ≥3 chars — the small filter used to match a
 * product_seo_keywords row against the caller's problem lane. Stopwords like "and"/"the" would
 * over-match, so they're dropped.
 */
const PROBLEM_STOPWORDS = new Set([
  "and", "the", "for", "with", "you", "your", "from", "that", "this", "have", "has",
  "get", "getting", "into", "out", "off", "not", "but", "any", "all", "are", "was", "were",
]);

export function problemTokens(problem: string): string[] {
  return String(problem ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !PROBLEM_STOPWORDS.has(t));
}

/**
 * The public chokepoint. Returns a SearchDemandRecord for one (ingredient, problem-lane) pair.
 *
 * Defense-in-depth: the arg surface is a fixed shape — callers cannot inject an alternate
 * table, select list, or filter clause. All Supabase interaction is confined here.
 */
export async function fetchSearchDemand(input: FetchSearchDemandInput): Promise<SearchDemandRecord> {
  const { admin, workspaceId, ingredient, problem } = input;
  const trimmedIngredient = String(ingredient ?? "").trim();
  if (!trimmedIngredient) {
    return activeProvider({ workspaceId, ingredient: trimmedIngredient, problem });
  }
  const { data, error } = await admin
    .from("product_seo_keywords")
    .select("keyword, monthly_searches, search_console_impressions")
    .eq("workspace_id", workspaceId)
    .ilike("keyword", `%${trimmedIngredient}%`);
  if (error) throw error;
  const rows = (data ?? []) as Array<{
    keyword: string | null;
    monthly_searches: number | null;
    search_console_impressions: number | null;
  }>;
  const tokens = problemTokens(problem);
  const matching = tokens.length === 0
    ? rows
    : rows.filter((r) => {
        const kw = String(r.keyword ?? "").toLowerCase();
        return tokens.some((t) => kw.includes(t));
      });
  if (matching.length === 0) {
    return activeProvider({ workspaceId, ingredient: trimmedIngredient, problem });
  }
  const maxVolume = matching.reduce((m, r) => {
    const v = (r.monthly_searches ?? 0) + (r.search_console_impressions ?? 0);
    return v > m ? v : m;
  }, 0);
  return {
    tier: tierForVolume(maxVolume),
    rawVolume: maxVolume,
    source: "product_seo_keywords",
  };
}
