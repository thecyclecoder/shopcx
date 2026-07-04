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
import { createBlueprint, type LanderBlueprintSkeleton, type LanderBlueprintBlock } from "@/lib/lander-blueprints";
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
 * Pick the target product for a teardown — the product whose benefit tree matches the
 * teardown's category. For Phase 2 the mapping is intentionally minimal: pick the FIRST
 * ACTIVE product in the workspace (deterministic order — by created_at ASC — so a repeat
 * sweep picks the same target). A richer category → product mapping (e.g. matching
 * teardown.brand or the teardown's product_type against products.tags / product_type) is
 * a Phase 3+ refinement — the spec verification's expectation ("Amazing Coffee for a
 * superfood-coffee teardown") already assumes the target workspace has a matching product
 * as its primary. Returns null when the workspace has no active product (skip the teardown).
 */
export async function pickTargetProduct(workspaceId: string): Promise<{ id: string; title: string } | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("products")
    .select("id, title, status")
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) return null;
  const row = (data as { id: string; title: string; status: string } | null) ?? null;
  return row ? { id: row.id, title: row.title } : null;
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
 * Cleo's blueprint sweep — the deterministic loop over new teardowns for a workspace.
 * For each teardown: pick the target product, load its existing lander_types, run
 * `decideBlueprintForTeardown`, then act:
 *
 *   • blueprint → `createBlueprint` (with the adapted skeleton) + enqueue `dr-content`
 *                 job (deduped) + `markTeardownReviewed`.
 *   • bandit    → `markTeardownReviewed` only (bandit path is unchanged — the teardown
 *                 is Cleo's information, not a job it needs to run).
 *   • skip      → `markTeardownReviewed` only (nothing to route).
 *
 * Idempotent under retries — `markTeardownReviewed` drops the row out of
 * `listNewTeardowns`, so a second sweep sees zero new teardowns. If a blueprint is
 * created but the sweep dies before the watermark stamps, the next sweep re-runs the
 * decision, the dedup gate catches the in-flight `dr-content` job, and the watermark
 * lands — no ghost writes.
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

  const target = await pickTargetProduct(workspaceId);
  if (!target) {
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

  const existingTypes = await existingLanderTypesForProduct(workspaceId, target.id);

  for (const teardown of teardowns) {
    try {
      const decision = decideBlueprintForTeardown(teardown, existingTypes);
      if (decision.kind === "blueprint") {
        const bp = await createBlueprint({
          workspace_id: workspaceId,
          product_id: target.id,
          research_url_id: teardown.id,
          funnel_type: decision.funnel_type,
          skeleton: decision.skeleton,
          rationale: decision.rationale,
          created_by: opts.createdBy ?? "cleo",
        });
        const jobId = await enqueueDrContentJob(workspaceId, bp.id, opts.createdBy ?? null);
        await markTeardownReviewed(workspaceId, teardown.id);
        entries.push({
          research_url_id: teardown.id,
          decision: "blueprint",
          rationale: decision.rationale,
          blueprint_id: bp.id,
          dr_content_job_id: jobId ?? undefined,
          target_product_id: target.id,
        });
        result.blueprints_created++;
      } else if (decision.kind === "bandit") {
        await markTeardownReviewed(workspaceId, teardown.id);
        entries.push({
          research_url_id: teardown.id,
          decision: "bandit",
          rationale: decision.rationale,
          target_product_id: target.id,
        });
        result.bandit_routed++;
      } else {
        await markTeardownReviewed(workspaceId, teardown.id);
        entries.push({
          research_url_id: teardown.id,
          decision: "skip",
          rationale: decision.rationale,
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
