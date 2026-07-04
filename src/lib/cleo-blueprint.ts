/**
 * Cleo's blueprint decision — the ONE judgment step in the teardown → build chain
 * (docs/brain/specs/cleo-lander-blueprint.md Phase 2). Runs off Rhea's discovery reader
 * ([[research-urls]] `listNewTeardowns`) and decides modify-vs-build-new per teardown:
 *
 *   • SINGLE REVERSIBLE LEVER (we already have a matching-funnel-type lander for the target
 *     product) → route to Cleo's existing bandit path (unchanged). No blueprint is created;
 *     the teardown is marked reviewed so it drops out of listNewTeardowns.
 *
 *   • WHOLE MISSING FUNNEL TYPE (we have no matching lander AND modifying ours means too many
 *     simultaneous test variables) → author a [[lander-blueprints]] row with the teardown's
 *     `transferable_pattern` adapted into `skeleton`, status `content_in_progress`, plus a
 *     rationale. Then DETERMINISTICALLY enqueue a `dr-content` (Carrie) [[agent_jobs]] job
 *     carrying the blueprint id (dedup an in-flight one) and stamp the teardown reviewed.
 *
 * North-star (supervisable autonomy): the sweep is deterministic + within Max's leash
 * (autonomous — Cleo owns the objective, the tool respects the funnel-diff guardrail).
 * Every decision surfaces its rationale on the blueprint row; nothing runs silently.
 *
 * Chokepoint discipline: this file is the sole caller of [[lander-blueprints]] `createBlueprint`
 * from a lane. All blueprint WRITES still go through [[lander-blueprints]] via
 * `createAdminClient()` (unchanged).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import {
  createBlueprint,
  hasBlueprintForProductType,
  type LanderBlueprintSkeleton,
  type LanderBlueprintBlock,
} from "@/lib/lander-blueprints";
import {
  listNewTeardowns,
  markTeardownReviewed,
  type ResearchUrl,
  type TeardownRecipe,
} from "@/lib/research-urls";

/**
 * The active statuses a `dr-content` [[agent_jobs]] row is considered "in-flight" for
 * dedup purposes — matches the vocabulary the box worker uses for its build-dedup gate.
 * A second sweep that sees the same blueprint id already carries an in-flight Carrie job
 * SKIPS the enqueue, so the deterministic loop is idempotent under retries.
 */
const ACTIVE_DR_CONTENT_STATUSES = [
  "queued",
  "claimed",
  "building",
  "needs_input",
  "needs_approval",
  "queued_resume",
] as const;

/**
 * The four lander types [[storefront_experiments]] supports today (CHECK constraint):
 * `pdp | listicle | beforeafter | advertorial`. Cleo's decision maps Rhea's free-text
 * `TeardownRecipe.funnel_type` into this vocabulary — a teardown whose funnel_type doesn't
 * map to any of these is treated as a WHOLE MISSING FUNNEL TYPE (blueprint), because our
 * storefront can't render it via the existing bandit path.
 */
export type StorefrontLanderType = "pdp" | "listicle" | "beforeafter" | "advertorial";

const KNOWN_LANDER_TYPES: readonly StorefrontLanderType[] = ["pdp", "listicle", "beforeafter", "advertorial"];

/**
 * Map Rhea's teardown `funnel_type` (free-text, e.g. `"advertorial-listicle"`, `"quiz"`,
 * `"generic_pdp"`, `"homepage"`) into our lander_type vocabulary. Substring match on
 * purpose — Rhea's vocabulary is broader than ours + we deliberately want fuzzy matching
 * so `"advertorial-listicle"` still routes to `advertorial`. Returns `null` when nothing
 * matches (the teardown is a WHOLE MISSING FUNNEL TYPE — always blueprint).
 */
export function mapFunnelTypeToLanderType(funnelType: string): StorefrontLanderType | null {
  const s = String(funnelType || "").toLowerCase().trim();
  if (!s) return null;
  // Order matters: 'advertorial-listicle' contains 'advertorial' AND 'listicle' — we
  // prefer the more-specific match here (listicle, the arrangement matters more than
  // the wrapper) so a listicle-style advertorial routes to our listicle experiments.
  if (s.includes("listicle")) return "listicle";
  if (s.includes("beforeafter") || s.includes("before_after") || s.includes("before-after")) return "beforeafter";
  if (s.includes("advertorial")) return "advertorial";
  if (s.includes("pdp") || s.includes("homepage") || s.includes("home_page") || s.includes("home-page")) return "pdp";
  return null;
}

/** The decision Cleo returns for one teardown. */
export type BlueprintDecision =
  | { kind: "blueprint"; funnel_type: string; lander_type: StorefrontLanderType | null; skeleton: LanderBlueprintSkeleton; rationale: string }
  | { kind: "bandit"; funnel_type: string; lander_type: StorefrontLanderType; rationale: string }
  | { kind: "skip"; rationale: string };

/**
 * Adapt Rhea's `TeardownRecipe` into the [[lander-blueprints]] `LanderBlueprintSkeleton` —
 * the ORDERED blocks to build (each carrying which levers/beats it implements). Preserves
 * Rhea's `architecture[]` order and pairs every block with the FULL set of levers Rhea saw
 * on this lander (Carrie will pick which levers each block actually carries when she writes
 * content). Optional `reason_sequence` is folded into per-block `notes` on any block whose
 * role name matches its order (best-effort). Free of a schema treadmill by design.
 */
export function adaptSkeletonFromTeardown(recipe: TeardownRecipe): LanderBlueprintSkeleton {
  const levers = (recipe.levers || []).map((l) => String(l.lever)).filter((s) => s.length > 0);
  // Fold the reason_sequence (if present) into blocks whose role encodes a reason position
  // (`reason_1`, `reason-2`, `reasons/3`, ...). Cheap heuristic — falls back to the plain
  // block.
  const reasonNotes = new Map<number, string>();
  for (const item of recipe.reason_sequence || []) {
    const line = `#${item.order} ${item.benefit} (${item.appeal}) — ${item.mechanism}`;
    reasonNotes.set(item.order, line);
  }
  const blocks: LanderBlueprintBlock[] = (recipe.architecture || []).map((chapter) => {
    const roleLower = String(chapter.chapter_role || "").toLowerCase();
    const orderMatch = roleLower.match(/reason[^0-9]*(\d+)/);
    const orderNum = orderMatch ? Number(orderMatch[1]) : null;
    const reasonNote = orderNum != null ? reasonNotes.get(orderNum) : undefined;
    return {
      role: String(chapter.chapter_role || "").trim(),
      purpose: String(chapter.purpose || "").trim(),
      levers: levers.length ? [...levers] : undefined,
      notes: reasonNote || undefined,
    };
  });
  return {
    blocks,
    hypothesis: recipe.transferable_pattern,
  };
}

/**
 * Pure decision helper — given ONE teardown, the target product's set of existing lander
 * types (the [[storefront_experiments]].lander_type values that already exist for that
 * product, in any status), and no external I/O, decide whether this teardown is a blueprint
 * (whole missing funnel type) or a bandit (single reversible lever) case.
 *
 * The rule:
 *   • Map Rhea's `teardown.funnel_type` → our lander_type via `mapFunnelTypeToLanderType`.
 *   • If no lander_type match → BLUEPRINT (our storefront can't render this funnel type).
 *   • If the mapped lander_type is NOT in `existingLanderTypes` → BLUEPRINT.
 *   • Else → BANDIT (we already have a lander of this funnel type; the gap is a lever, not a type).
 *
 * The `existingLanderTypes` set is what the caller has ALREADY OBSERVED for the target
 * product — this function stays pure so unit tests can pin the boundary cases without
 * standing up a DB.
 */
export function decideBlueprintForTeardown(
  teardown: ResearchUrl,
  existingLanderTypes: ReadonlySet<StorefrontLanderType>,
): BlueprintDecision {
  const recipe = teardown.teardown;
  if (!recipe) {
    return { kind: "skip", rationale: "teardown recipe missing — nothing to diff against" };
  }
  const funnel = String(recipe.funnel_type || "").trim();
  if (!funnel) {
    return { kind: "skip", rationale: "teardown funnel_type empty — cannot map to a lander_type" };
  }
  const mapped = mapFunnelTypeToLanderType(funnel);
  if (!mapped) {
    // A funnel we can't render at all (e.g. `quiz`). Whole-missing-funnel-type by definition.
    const skeleton = adaptSkeletonFromTeardown(recipe);
    return {
      kind: "blueprint",
      funnel_type: funnel,
      lander_type: null,
      skeleton,
      rationale: `funnel_type '${funnel}' has no matching lander_type in our storefront vocabulary — whole missing funnel type, build-new`,
    };
  }
  if (!existingLanderTypes.has(mapped)) {
    const skeleton = adaptSkeletonFromTeardown(recipe);
    return {
      kind: "blueprint",
      funnel_type: funnel,
      lander_type: mapped,
      skeleton,
      rationale: `no existing '${mapped}' lander for this product — whole missing funnel type, build-new (modifying our current landers would carry too many simultaneous test variables)`,
    };
  }
  return {
    kind: "bandit",
    funnel_type: funnel,
    lander_type: mapped,
    rationale: `we already have a '${mapped}' lander for this product — single-lever gap, route to the existing bandit path (no blueprint)`,
  };
}

/**
 * Minimal token summary of a product — everything `matchProductToTeardown` needs to score
 * the product against a teardown text blob. Split from the DB row so unit tests can pin
 * the matcher without a Supabase client.
 */
export interface ProductForMatch {
  id: string;
  title: string;
  handle?: string | null;
}

/**
 * Tiny English stopword set — the tokens we drop when tokenizing product title/handle
 * (and the teardown blob). Kept small on purpose: the matcher scores by whole-word
 * OVERLAP between the product and the teardown, so stopwords like "the" / "our" would
 * cause false-positive matches ("The Longevity Answer" would score against "The Coffee
 * Roast") if we kept them in. Extend cautiously — the head-noun rule already carries
 * the semantic weight.
 */
const PRODUCT_TOKEN_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "or", "with", "of", "for", "to", "in", "on", "at",
  "our", "your", "my", "by", "from", "is", "it", "as", "be", "we", "us",
]);

/**
 * Split a free-text string into lowercased, deduped word tokens (min length 2, no
 * stopwords). Non-word chars are the split boundary — so `"amazing-coffee"` and
 * `"amazing_coffee"` both become `["amazing", "coffee"]`. Deterministic + pure.
 */
export function tokenizeForMatch(text: string): string[] {
  const s = String(text || "").toLowerCase();
  const raw = s.split(/[^a-z0-9]+/g).filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (t.length < 2) continue;
    if (PRODUCT_TOKEN_STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Extract the head-noun of a product title — the LAST non-stopword token, lowercased.
 * `"Amazing Coffee"` → `"coffee"`; `"Superfood Tabs"` → `"tabs"`; `"The Longevity Answer"`
 * → `"answer"` (drops "the"; picks the last content word). Returns null when the title
 * is empty or contains only stopwords. Deterministic + pure.
 */
export function productHeadNoun(title: string): string | null {
  const tokens = tokenizeForMatch(title);
  if (!tokens.length) return null;
  return tokens[tokens.length - 1];
}

/**
 * Build the teardown text blob the matcher scores against — brand + funnel_type +
 * strategy + transferable_pattern, joined by spaces. The FOUR fields the spec calls out
 * (docs/brain/specs/cleo-blueprint-product-matching.md Phase 1). Kept separate so the
 * unit tests can construct a blob without a full ResearchUrl row.
 */
export function teardownMatchBlob(brand: string | null | undefined, recipe: TeardownRecipe | null | undefined): string {
  const parts: string[] = [];
  if (brand) parts.push(brand);
  if (recipe?.funnel_type) parts.push(recipe.funnel_type);
  if (recipe?.strategy) parts.push(recipe.strategy);
  if (recipe?.transferable_pattern) parts.push(recipe.transferable_pattern);
  return parts.join(" ");
}

/**
 * Pure category matcher — pick the product whose title/handle head-noun (weight 2) +
 * other title/handle tokens (weight 1) appear as WHOLE WORDS in the teardown's text blob
 * (`brand` + recipe `funnel_type` + `strategy` + `transferable_pattern`), highest score
 * wins. Score-0 products are DROPPED (return null — we don't sell that category, so
 * we skip rather than blueprinting the wrong product).
 *
 *   Superfood-coffee teardown blob contains `"coffee"` → Amazing Coffee scores ≥2 (head-
 *   noun hit) + optionally 1 for `"amazing"` in the blob; Superfood Tabs scores at most 1
 *   (`"superfood"` in the blob but head-noun `"tabs"` misses) → Amazing Coffee wins.
 *
 *   Longevity teardown blob contains none of `"amazing"`, `"coffee"`, `"superfood"`,
 *   `"tabs"` → every product scores 0 → return null (skip — we don't sell longevity).
 *
 * Ties break by input order (first product wins). The `products` list is expected to be
 * ordered deterministically by the caller (created_at ASC) so a repeat sweep picks the
 * same target. Pure — no DB, no clock, no randomness.
 */
export function matchProductToTeardown(
  teardown: Pick<ResearchUrl, "brand" | "teardown">,
  products: ReadonlyArray<ProductForMatch>,
): ProductForMatch | null {
  if (!products.length) return null;
  const blobTokens = new Set(tokenizeForMatch(teardownMatchBlob(teardown.brand, teardown.teardown)));
  if (!blobTokens.size) return null;
  let best: { product: ProductForMatch; score: number } | null = null;
  for (const product of products) {
    const titleTokens = tokenizeForMatch(product.title);
    const handleTokens = tokenizeForMatch(product.handle ?? "");
    const head = productHeadNoun(product.title);
    // Union title + handle tokens (excluding head-noun — head-noun scored separately at
    // weight 2). Handle tokens exist to catch cases where the handle carries a token the
    // title doesn't ("amazing-coffee" handle for a "The Coffee" product).
    const otherTokens = new Set<string>();
    for (const t of titleTokens) if (t !== head) otherTokens.add(t);
    for (const t of handleTokens) if (t !== head) otherTokens.add(t);
    let score = 0;
    if (head && blobTokens.has(head)) score += 2;
    for (const t of otherTokens) if (blobTokens.has(t)) score += 1;
    if (score <= 0) continue;
    if (!best || score > best.score) {
      best = { product, score };
    }
  }
  return best?.product ?? null;
}

/**
 * Load every ACTIVE product in the workspace, deterministically ordered (created_at ASC)
 * — the input to `matchProductToTeardown`. Extracted so the sweep can load once and
 * reuse across all teardowns in a run (was a per-sweep single-product punt in Phase 2).
 */
export async function listActiveProducts(workspaceId: string): Promise<ProductForMatch[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("products")
    .select("id, title, handle, status")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error) return [];
  const rows = (data ?? []) as Array<{ id: string; title: string; handle: string | null; status: string }>;
  return rows.map((r) => ({ id: r.id, title: r.title, handle: r.handle }));
}

/**
 * Pick the target product for a teardown — the product whose head-noun/tokens overlap
 * the teardown's text blob (brand + funnel_type + strategy + transferable_pattern). See
 * `matchProductToTeardown` for the scoring rule. Returns null when no product's category
 * matches (we don't sell that category — the sweep SKIPS instead of blueprinting the
 * wrong product).
 *
 * The `teardown` argument is optional for BACK-COMPAT with the pre-Phase-1 signature: if
 * omitted, we fall back to the deterministic first-active-product punt (the original
 * behavior). Every in-tree caller passes a teardown; the fallback is preserved so
 * external test-harness / probe scripts that call this without one still work.
 */
export async function pickTargetProduct(
  workspaceId: string,
  teardown?: Pick<ResearchUrl, "brand" | "teardown">,
): Promise<{ id: string; title: string } | null> {
  const products = await listActiveProducts(workspaceId);
  if (!products.length) return null;
  if (!teardown) {
    const first = products[0];
    return { id: first.id, title: first.title };
  }
  const match = matchProductToTeardown(teardown, products);
  return match ? { id: match.id, title: match.title } : null;
}

/**
 * Load the set of `lander_type` values [[storefront_experiments]] carries for a product
 * — the input for the decision helper's diff. Returns an empty set when the product has
 * no experiments yet (every funnel type is missing → every teardown blueprints).
 */
async function existingLanderTypesForProduct(
  workspaceId: string,
  productId: string,
): Promise<Set<StorefrontLanderType>> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("storefront_experiments")
    .select("lander_type")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);
  const out = new Set<StorefrontLanderType>();
  if (error || !data) return out;
  for (const row of data as Array<{ lander_type: string }>) {
    const t = row.lander_type as StorefrontLanderType;
    if (KNOWN_LANDER_TYPES.includes(t)) out.add(t);
  }
  return out;
}

/**
 * Has a `dr-content` job already been enqueued for this blueprint? Dedup gate for the
 * sweep — a second invocation that sees the same blueprint id already carries an in-flight
 * Carrie job skips the enqueue. The blueprint id lives in `agent_jobs.spec_slug` (free-text
 * — the box worker uses the same column to key job-target lookups across kinds).
 */
async function hasActiveDrContentJob(workspaceId: string, blueprintId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("agent_jobs")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("kind", "dr-content")
    .eq("spec_slug", blueprintId)
    .in("status", [...ACTIVE_DR_CONTENT_STATUSES])
    .limit(1)
    .maybeSingle();
  return !!data;
}

/**
 * Enqueue Carrie's `dr-content` [[agent_jobs]] job carrying the blueprint id in
 * `spec_slug`. Deduped — a repeat sweep against an in-flight job is a no-op. Returns the
 * new job id, or `null` when the dedup gate fired (already enqueued).
 */
async function enqueueDrContentJob(
  workspaceId: string,
  blueprintId: string,
  createdBy: string | null,
): Promise<string | null> {
  if (await hasActiveDrContentJob(workspaceId, blueprintId)) return null;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({
      workspace_id: workspaceId,
      spec_slug: blueprintId,
      kind: "dr-content",
      status: "queued",
      created_by: createdBy,
      instructions: `Write DR content for lander_blueprint ${blueprintId}. Read the blueprint's skeleton, fill copy per block via setBlueprintContent, then advance status to content_complete (or awaiting_upload if assets are needed).`,
    })
    .select("id")
    .single();
  if (error) return null;
  return (data as { id: string } | null)?.id ?? null;
}

/** One-row summary of what Cleo did for a single teardown — used for logs + return value. */
export interface BlueprintSweepEntry {
  research_url_id: string;
  decision: BlueprintDecision["kind"];
  rationale: string;
  blueprint_id?: string;
  dr_content_job_id?: string;
  target_product_id?: string;
}

export interface BlueprintSweepResult {
  scanned: number;
  blueprints_created: number;
  bandit_routed: number;
  skipped: number;
  entries: BlueprintSweepEntry[];
}

/**
 * Deterministic dedup key for the `(product_id, funnel_type)` pair the spec's Phase 1
 * verification pins ("AT MOST ONE blueprint per (product, funnel_type)"). Pure — used by
 * both the within-sweep `seenKeys` set AND (in the sweep loop) checked against existing
 * `lander_blueprints` rows via `hasBlueprintForProductType`. Extracted so unit tests can
 * pin the dedup without a DB.
 */
export function blueprintDedupKey(productId: string, funnelType: string): string {
  return `${productId}::${String(funnelType || "").trim()}`;
}

/**
 * Cleo's blueprint sweep — the deterministic loop over new teardowns for a workspace.
 * Phase 1 rewrite (cleo-blueprint-product-matching): load every active product ONCE up
 * front and, per teardown, match it to a product by category (head-noun / title token
 * overlap on the teardown's brand + funnel_type + strategy + transferable_pattern blob);
 * null match → skip (we don't sell that category). Then diff vs the target product's
 * existing lander_types (cached per product across the loop) and, on a blueprint
 * decision, DEDUP by `(product_id, funnel_type)` against both a this-sweep Set AND
 * existing `lander_blueprints` rows via `hasBlueprintForProductType` — a second
 * advertorial teardown for the same product is a SKIP, not a duplicate blueprint.
 *
 *   • blueprint → `createBlueprint` (with the adapted skeleton) + enqueue `dr-content`
 *                 job (deduped) + `markTeardownReviewed`. Records the key in
 *                 `seenKeys` so a later teardown in the same sweep can't create a dup.
 *   • dup       → `markTeardownReviewed` only — the target-product+funnel_type already
 *                 has a blueprint (either from earlier in this sweep or a prior sweep).
 *   • bandit    → `markTeardownReviewed` only (bandit path is unchanged — the teardown
 *                 is Cleo's information, not a job it needs to run).
 *   • skip      → `markTeardownReviewed` only (nothing to route — no product match, or
 *                 the recipe was missing).
 *
 * Idempotent under retries — `markTeardownReviewed` drops the row out of
 * `listNewTeardowns`, so a second sweep sees zero new teardowns. If a blueprint is
 * created but the sweep dies before the watermark stamps, the next sweep re-runs the
 * decision, the `hasBlueprintForProductType` gate catches the just-created blueprint,
 * the dedup fires, and the watermark lands — no ghost writes, no duplicate blueprints.
 *
 * Errors are contained per-teardown (each iteration try/caught) so one bad row never
 * poisons the sweep. Returns a structured summary — the caller (Cleo's lane in
 * [[builder-worker]]) logs it.
 */
export async function runCleoBlueprintSweep(
  workspaceId: string,
  opts: { createdBy?: string | null; limit?: number } = {},
): Promise<BlueprintSweepResult> {
  const entries: BlueprintSweepEntry[] = [];
  const result: BlueprintSweepResult = {
    scanned: 0,
    blueprints_created: 0,
    bandit_routed: 0,
    skipped: 0,
    entries,
  };
  const teardowns = await listNewTeardowns(workspaceId, opts.limit ?? 50);
  result.scanned = teardowns.length;
  if (!teardowns.length) return result;

  const products = await listActiveProducts(workspaceId);
  if (!products.length) {
    for (const t of teardowns) {
      try { await markTeardownReviewed(workspaceId, t.id); } catch { /* leave watermark for next sweep */ }
      entries.push({
        research_url_id: t.id,
        decision: "skip",
        rationale: "no active product in workspace — nothing to target",
      });
      result.skipped++;
    }
    return result;
  }

  // Per-product caches — the existing `storefront_experiments.lander_type` set (input to
  // `decideBlueprintForTeardown`) and the per-sweep `(product_id, funnel_type)` dedup set.
  // Both filled lazily on first hit so we never load state for products no teardown maps to.
  const existingTypesByProduct = new Map<string, Set<StorefrontLanderType>>();
  const seenKeys = new Set<string>();

  for (const teardown of teardowns) {
    try {
      const match = matchProductToTeardown(teardown, products);
      if (!match) {
        await markTeardownReviewed(workspaceId, teardown.id);
        entries.push({
          research_url_id: teardown.id,
          decision: "skip",
          rationale: "no product in our catalog matches this teardown's category",
        });
        result.skipped++;
        continue;
      }
      let existingTypes = existingTypesByProduct.get(match.id);
      if (!existingTypes) {
        existingTypes = await existingLanderTypesForProduct(workspaceId, match.id);
        existingTypesByProduct.set(match.id, existingTypes);
      }
      const decision = decideBlueprintForTeardown(teardown, existingTypes);
      if (decision.kind === "blueprint") {
        const key = blueprintDedupKey(match.id, decision.funnel_type);
        if (seenKeys.has(key) || (await hasBlueprintForProductType(workspaceId, match.id, decision.funnel_type))) {
          await markTeardownReviewed(workspaceId, teardown.id);
          entries.push({
            research_url_id: teardown.id,
            decision: "skip",
            rationale: `duplicate — blueprint for (${match.title}, funnel_type='${decision.funnel_type}') already exists; skipping to hold ONE-per-(product, funnel_type)`,
            target_product_id: match.id,
          });
          result.skipped++;
          continue;
        }
        const bp = await createBlueprint({
          workspace_id: workspaceId,
          product_id: match.id,
          research_url_id: teardown.id,
          funnel_type: decision.funnel_type,
          skeleton: decision.skeleton,
          rationale: decision.rationale,
          created_by: opts.createdBy ?? "cleo",
        });
        seenKeys.add(key);
        const jobId = await enqueueDrContentJob(workspaceId, bp.id, opts.createdBy ?? null);
        await markTeardownReviewed(workspaceId, teardown.id);
        entries.push({
          research_url_id: teardown.id,
          decision: "blueprint",
          rationale: decision.rationale,
          blueprint_id: bp.id,
          dr_content_job_id: jobId ?? undefined,
          target_product_id: match.id,
        });
        result.blueprints_created++;
      } else if (decision.kind === "bandit") {
        await markTeardownReviewed(workspaceId, teardown.id);
        entries.push({
          research_url_id: teardown.id,
          decision: "bandit",
          rationale: decision.rationale,
          target_product_id: match.id,
        });
        result.bandit_routed++;
      } else {
        await markTeardownReviewed(workspaceId, teardown.id);
        entries.push({
          research_url_id: teardown.id,
          decision: "skip",
          rationale: decision.rationale,
          target_product_id: match.id,
        });
        result.skipped++;
      }
    } catch (e) {
      entries.push({
        research_url_id: teardown.id,
        decision: "skip",
        rationale: `error during decision: ${e instanceof Error ? e.message : String(e)}`,
      });
      result.skipped++;
      // Do NOT mark reviewed on error — a next sweep can retry.
    }
  }
  return result;
}
