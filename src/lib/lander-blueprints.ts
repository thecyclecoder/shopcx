/**
 * Cleo's teardown → build-new blueprint SDK — the ONLY write path to public.lander_blueprints
 * (docs/brain/specs/cleo-lander-blueprint.md Phase 1). One row per (product × source teardown)
 * pair Cleo has decided is a WHOLE-MISSING-FUNNEL-TYPE case (not a single reversible lever —
 * those still route to her existing bandit path, unchanged).
 *
 * Design: a distinct ENTITY (not a research_urls flag) because it carries a build lifecycle:
 * content_in_progress → awaiting_upload → content_complete → build_submitted (or → rejected).
 *
 * North-star (supervisable autonomy): Cleo (Max's leash) deterministically proposes a
 * blueprint off a worthy teardown; Carrie (dr-content) fills content within the same leash;
 * the build submission is where Ada/Platform's build discipline takes over. Each step
 * surfaces its reasoning + rationale + status transitions — never a silent proxy-optimizer.
 *
 * Chokepoint discipline: every WRITE to lander_blueprints goes through here via
 * createAdminClient() — no raw `.from('lander_blueprints').insert|update|upsert` outside this
 * file (same discipline as [[research-urls]] / [[specs-table]] / goals-table).
 */
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Build lifecycle for a blueprint. Matches the CHECK constraint on
 * public.lander_blueprints.status.
 *
 *   content_in_progress — Cleo just landed the row; Carrie's dr-content job is queued.
 *   awaiting_upload     — Carrie needs assets (hero image, testimonials, ...) from ops.
 *   content_complete    — every block in `content` is filled; ready for build submit.
 *   build_submitted     — the build was handed to Ada/Platform (spec_phases authored off it).
 *   rejected            — Cleo (or an owner) killed the blueprint (re-surface the teardown).
 */
export type LanderBlueprintStatus =
  | "content_in_progress"
  | "awaiting_upload"
  | "content_complete"
  | "build_submitted"
  | "rejected";

/**
 * One ordered block in the `skeleton` — the transferable_pattern adapted to our benefit tree.
 * Kept loose on purpose (funnel types vary); the shape is documented but not enforced beyond
 * `role` + `purpose` — the point is Cleo can carry Rhea's ordered chapters into the row
 * without a schema treadmill.
 */
export interface LanderBlueprintBlock {
  /** Chapter role from the teardown (e.g. "hero", "intro/proof", "reason_1", "offer", "faq"). */
  role: string;
  /** One-sentence purpose — what this block should do for the reader. */
  purpose: string;
  /** Optional levers this block carries (Rhea's tagged persuasion primitives). */
  levers?: string[];
  /** Optional notes from Cleo — what to preserve from the teardown, what to adapt. */
  notes?: string;
}

/**
 * The transferable_pattern adapted to our benefit tree — the ordered blocks to build. Carrie's
 * later content pass fills copy per block into `content`; `skeleton` stays the STRUCTURE.
 */
export interface LanderBlueprintSkeleton {
  /** Ordered blocks top-to-bottom of the new lander. */
  blocks: LanderBlueprintBlock[];
  /** Optional one-sentence hypothesis Cleo is testing with this build. */
  hypothesis?: string;
}

/**
 * Carrie's copy pass, block-by-block. Mirrors `skeleton.blocks` order so a reader can zip
 * them; each entry carries the concrete copy + any asset refs Carrie has chosen. Null on
 * the row until Carrie writes.
 */
export interface LanderBlueprintContentBlock {
  /** The `skeleton.blocks[i].role` this content targets. */
  role: string;
  /** Headline / body copy per block — free-text for Phase 1, structured in later phases. */
  copy: string;
  /** Optional asset references (image / video URLs, prompt seeds, etc). */
  assets?: { kind: string; ref: string }[];
}

export interface LanderBlueprintContent {
  /** Per-block copy, in `skeleton.blocks` order. */
  blocks: LanderBlueprintContentBlock[];
  /** Optional overall CTA copy. */
  cta?: string;
}

export interface LanderBlueprint {
  id: string;
  workspace_id: string;
  product_id: string;
  research_url_id: string | null;
  funnel_type: string;
  skeleton: LanderBlueprintSkeleton;
  status: LanderBlueprintStatus;
  rationale: string | null;
  content: LanderBlueprintContent | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface LanderBlueprintFilter {
  product_id?: string;
  research_url_id?: string;
  status?: LanderBlueprintStatus;
  funnel_type?: string;
  limit?: number;
}

export interface CreateBlueprintInput {
  workspace_id: string;
  product_id: string;
  research_url_id: string | null;
  funnel_type: string;
  skeleton: LanderBlueprintSkeleton;
  rationale?: string | null;
  /** Author of the row — 'cleo' for the deterministic session, operator email on manual. */
  created_by?: string | null;
}

const STATUSES: readonly LanderBlueprintStatus[] = [
  "content_in_progress",
  "awaiting_upload",
  "content_complete",
  "build_submitted",
  "rejected",
];

/**
 * Validate a skeleton before it hits the row. Same discipline as
 * [[research-urls]] `validateTeardownRecipe` — the SDK is the only write path, so this is
 * where we keep the artifact honest. A half-formed skeleton (no blocks, or a block missing
 * role/purpose) is REJECTED here. Throws on any failure; returns void on pass.
 */
export function validateSkeleton(skeleton: LanderBlueprintSkeleton): void {
  if (!skeleton || typeof skeleton !== "object") {
    throw new Error("lander-blueprints: skeleton must be an object");
  }
  if (!Array.isArray(skeleton.blocks) || skeleton.blocks.length === 0) {
    throw new Error("lander-blueprints: skeleton.blocks must be a non-empty array");
  }
  for (const block of skeleton.blocks) {
    if (!block || typeof block !== "object") {
      throw new Error("lander-blueprints: every skeleton.blocks entry must be an object");
    }
    if (!block.role || typeof block.role !== "string") {
      throw new Error("lander-blueprints: every skeleton.blocks entry needs a non-empty role");
    }
    if (!block.purpose || typeof block.purpose !== "string") {
      throw new Error("lander-blueprints: every skeleton.blocks entry needs a non-empty purpose");
    }
  }
}

/**
 * Cleo's blueprint INSERT — the deterministic write when a worthy teardown is a whole-missing-
 * funnel-type gap. Validates the skeleton, defaults status to 'content_in_progress' (matches
 * the CHECK constraint's DEFAULT), and returns the freshly-landed row so the caller can
 * enqueue Carrie's dr-content job carrying the id.
 */
export async function createBlueprint(input: CreateBlueprintInput): Promise<LanderBlueprint> {
  validateSkeleton(input.skeleton);
  if (!input.funnel_type || typeof input.funnel_type !== "string") {
    throw new Error("createBlueprint: funnel_type is required");
  }
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("lander_blueprints")
    .insert({
      workspace_id: input.workspace_id,
      product_id: input.product_id,
      research_url_id: input.research_url_id,
      funnel_type: input.funnel_type,
      skeleton: input.skeleton,
      rationale: input.rationale ?? null,
      created_by: input.created_by ?? null,
    })
    .select("*")
    .single();
  if (error) throw new Error(`createBlueprint: ${error.message}`);
  return data as LanderBlueprint;
}

/** Fetch ONE blueprint by id (workspace-scoped). Returns null when it doesn't exist. */
export async function getBlueprint(workspaceId: string, id: string): Promise<LanderBlueprint | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("lander_blueprints")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getBlueprint: ${error.message}`);
  return (data as LanderBlueprint | null) ?? null;
}

/** List a workspace's blueprints, optionally filtered by product / source teardown / status. */
export async function listBlueprints(
  workspaceId: string,
  filter: LanderBlueprintFilter = {},
): Promise<LanderBlueprint[]> {
  const admin = createAdminClient();
  let q = admin.from("lander_blueprints").select("*").eq("workspace_id", workspaceId);
  if (filter.product_id) q = q.eq("product_id", filter.product_id);
  if (filter.research_url_id) q = q.eq("research_url_id", filter.research_url_id);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.funnel_type) q = q.eq("funnel_type", filter.funnel_type);
  q = q.order("created_at", { ascending: false }).limit(filter.limit ?? 200);
  const { data, error } = await q;
  if (error) throw new Error(`listBlueprints: ${error.message}`);
  return (data || []) as LanderBlueprint[];
}

/**
 * Advance the build lifecycle — content_in_progress → awaiting_upload → content_complete →
 * build_submitted (or → rejected). The SDK is the only path, so this is where the vocabulary
 * is enforced; the DB CHECK is the belt+suspenders.
 */
export async function setBlueprintStatus(
  workspaceId: string,
  id: string,
  status: LanderBlueprintStatus,
): Promise<void> {
  if (!STATUSES.includes(status)) {
    throw new Error(`setBlueprintStatus: unknown status '${status}'`);
  }
  const admin = createAdminClient();
  const { error } = await admin
    .from("lander_blueprints")
    .update({ status })
    .eq("id", id)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`setBlueprintStatus: ${error.message}`);
}

/**
 * Carrie's content write — the per-block copy + assets. Keeps `skeleton` untouched (that's
 * structure); `content` is the copy layer. The SDK is the only path, so this is where the
 * shape is enforced.
 */
export async function setBlueprintContent(
  workspaceId: string,
  id: string,
  content: LanderBlueprintContent,
): Promise<void> {
  if (!content || typeof content !== "object") {
    throw new Error("setBlueprintContent: content must be an object");
  }
  if (!Array.isArray(content.blocks) || content.blocks.length === 0) {
    throw new Error("setBlueprintContent: content.blocks must be a non-empty array");
  }
  for (const block of content.blocks) {
    if (!block || !block.role || typeof block.copy !== "string") {
      throw new Error("setBlueprintContent: every content.blocks entry needs role + copy");
    }
  }
  const admin = createAdminClient();
  const { error } = await admin
    .from("lander_blueprints")
    .update({ content })
    .eq("id", id)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`setBlueprintContent: ${error.message}`);
}
