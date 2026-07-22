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
 * Phase 2 adds `runSweepForProduct` (below): enumerates a fixed theme × problem lane table over the
 * product's ingredients, refreshes the search-demand tier on existing product_angle_palette rows,
 * upserts is_active=false drafts for previously-uncovered high-demand lanes (owner-gated — the
 * sweep NEVER flips a row active), and writes one director_activity audit row per run summarizing
 * the counts + provider (the north-star supervisability rail).
 *
 * See docs/brain/tables/product_seo_keywords.md and docs/brain/tables/product_angle_palette.md.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  listAnglePalette,
  refreshAngleSearchDemand,
  upsertAngle,
  type AngleTheme,
  type ProductAngle,
  type SearchDemand,
} from "./angle-palette";
import { getProductIntelligence } from "@/lib/product-intelligence";
import { recordDirectorActivity } from "@/lib/director-activity";

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

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — sweep executor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fixed enumeration of theme × problem lanes swept per ingredient. Kept as a constant table
 * (not a computed cross-product) so the audit trail is explicit — a later spec can add / drop /
 * rename a lane by editing this table alone, and every change lands in git rather than in
 * runtime state.
 *
 * A new lane sweeps immediately on the next cron tick — no migration, no code change past this
 * table. A retired lane stops surfacing new drafts; already-shipped rows for that lane stay put
 * (owner-managed via the angles page).
 */
export const PROBLEM_LANES: ReadonlyArray<{ theme: AngleTheme; problem: string }> = [
  { theme: "beauty", problem: "wrinkles and aging skin" },
  { theme: "beauty", problem: "hair thinning" },
  { theme: "beauty", problem: "brittle nails" },
  { theme: "longevity", problem: "joint pain" },
  { theme: "longevity", problem: "bone health" },
  { theme: "longevity", problem: "aging" },
  { theme: "healthy_weight", problem: "appetite control" },
  { theme: "healthy_weight", problem: "belly fat" },
  { theme: "healthy_weight", problem: "sugar cravings" },
  { theme: "energy_performance", problem: "morning fatigue" },
  { theme: "energy_performance", problem: "afternoon crash" },
  { theme: "energy_performance", problem: "workout recovery" },
  { theme: "focus", problem: "brain fog" },
  { theme: "focus", problem: "attention span" },
  { theme: "gut", problem: "bloating" },
  { theme: "gut", problem: "digestive discomfort" },
  { theme: "gut", problem: "gut health" },
];

export interface SweepSummary {
  rowsRefreshed: number;
  draftsCreated: number;
  provider: string;
}

export interface RunSweepForProductInput {
  admin: Admin;
  workspaceId: string;
  productId: string;
  /**
   * Test seam — bypass getProductIntelligence and use these ingredient names directly. In prod
   * this stays undefined and the executor sources ingredients from product_ingredients via the
   * product-intelligence SDK (keeps the raw-.from() ban intact).
   */
  ingredientNames?: string[];
}

/**
 * Ingredient sweep executor. For each (ingredient × PROBLEM_LANES lane):
 *   • refreshes search_demand on the existing product_angle_palette row (SDK-only), OR
 *   • upserts an is_active=false, source='dahlia_fanned' draft when the lane has tier:'high' but
 *     no existing row (owner promotes via the angles page — the sweep NEVER flips is_active).
 *
 * Writes ONE `director_activity` row per run summarizing the counts + providers so the audit
 * trail is inspectable (the north-star supervisability rail).
 *
 * NEVER writes to product_angle_palette via a raw `.from(...)` — every mutation flows through the
 * angle-palette SDK (`refreshAngleSearchDemand` / `upsertAngle`), and the sweep NEVER touches
 * is_active on refresh + only ever writes false on insert.
 */
export async function runSweepForProduct(input: RunSweepForProductInput): Promise<SweepSummary> {
  const { admin, workspaceId, productId } = input;
  const runIso = new Date().toISOString();

  const ingredientNames = input.ingredientNames ?? await loadIngredientNames(admin, workspaceId, productId);
  const existing = await listAnglePalette(admin, workspaceId, productId, { includeInactive: true });
  const existingByKey = new Map<string, ProductAngle>();
  for (const a of existing) existingByKey.set(`${a.theme}::${a.problem}`, a);

  let rowsRefreshed = 0;
  let draftsCreated = 0;
  const providers = new Set<string>();

  for (const ingredient of ingredientNames) {
    for (const lane of PROBLEM_LANES) {
      const demand = await fetchSearchDemand({ admin, workspaceId, ingredient, problem: lane.problem });
      providers.add(demand.source);
      const key = `${lane.theme}::${lane.problem}`;
      const match = existingByKey.get(key);
      if (match) {
        await refreshAngleSearchDemand(admin, match.id, {
          searchDemand: demand.tier,
          notes: buildProvenance({ runIso, ingredient, demand }),
        });
        rowsRefreshed++;
        continue;
      }
      if (demand.tier === "high") {
        await upsertAngle(admin, workspaceId, productId, {
          theme: lane.theme,
          problem: lane.problem,
          ingredients: [ingredient],
          evidenceTier: "customer_only",
          searchDemand: "high",
          source: "dahlia_fanned",
          isActive: false, // owner promotes via the angles page — the sweep is gated per the north-star rail
          notes: buildProvenance({ runIso, ingredient, demand }),
        });
        draftsCreated++;
      }
    }
  }

  const provider = providers.size === 0 ? "none" : providers.size === 1 ? [...providers][0]! : [...providers].sort().join("+");

  await recordDirectorActivity(admin, {
    workspaceId,
    directorFunction: "growth",
    actionKind: "angle_demand_sweep_ran",
    reason: `swept ${ingredientNames.length} ingredient(s) × ${PROBLEM_LANES.length} lane(s); refreshed=${rowsRefreshed} drafted=${draftsCreated} via ${provider}`,
    metadata: {
      product_id: productId,
      ingredients: ingredientNames,
      lanes: PROBLEM_LANES.length,
      rows_refreshed: rowsRefreshed,
      drafts_created: draftsCreated,
      provider,
      autonomous: true,
    },
  });

  return { rowsRefreshed, draftsCreated, provider };
}

/** getProductIntelligence returns rows with a `name` column (product_ingredients.name). */
async function loadIngredientNames(admin: Admin, workspaceId: string, productId: string): Promise<string[]> {
  const pi = await getProductIntelligence(admin, workspaceId, productId);
  return pi.ingredients
    .map((r) => String((r as { name?: unknown }).name ?? "").trim())
    .filter((n) => n.length > 0);
}

/**
 * Plain-language provenance line stamped into notes so a reader (Dahlia, an owner, a later audit)
 * can see exactly which sweep run last touched this row.
 */
function buildProvenance(args: { runIso: string; ingredient: string; demand: SearchDemandRecord }): string {
  const vol = args.demand.rawVolume === null ? "unknown" : String(args.demand.rawVolume);
  return `angle-demand-sweep @ ${args.runIso}: ingredient=${args.ingredient} tier=${args.demand.tier} volume=${vol} source=${args.demand.source}`;
}
