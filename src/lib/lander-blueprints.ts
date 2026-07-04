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

// ─────────────────────────────────────────────────────────────────────────────
// Carrie's DR content STORE — Phase 1 of carrie-dr-content.md
//
// Two SDK surfaces piggyback on this file because they're the same idea:
//
//   • `product_media` categorized reader/writer — a DR asset is permanent,
//     categorized product intelligence keyed by product_id + category.
//   • `lander_content_gaps` create/list/resolve — one row per real-evidence
//     asset Carrie can't ethically generate, routed to Max for upload.
//
// Chokepoint discipline: no raw
// `.from('product_media' | 'lander_content_gaps').insert|update|upsert` for
// these DR paths outside this file (createAdminClient() is only reached here).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persuasive job of a `product_media` asset. Matches the CHECK constraint on
 * `product_media.category` and is what Carrie reads by ("do we already have a
 * lifestyle shot for this product?").
 *
 *   before_after     — a real transformation story (NEVER generated)
 *   ugc              — a real customer selfie (NEVER generated)
 *   testimonial_photo— a real customer's photo (NEVER generated)
 *   press_logo       — press / certification logo (NEVER generated)
 *   lifestyle        — illustrative lifestyle shot (generatable)
 *   hero             — product hero (generatable)
 *   ingredient       — ingredient close-up (generatable)
 *   mechanism        — mechanism-of-action diagram (generatable)
 *   other            — escape hatch
 */
export type ProductMediaCategory =
  | "before_after"
  | "ugc"
  | "testimonial_photo"
  | "press_logo"
  | "lifestyle"
  | "hero"
  | "ingredient"
  | "mechanism"
  | "other";

/** How a `product_media` row was sourced. Matches the CHECK on `product_media.source`. */
export type ProductMediaSource = "uploaded" | "generated" | "scout" | "shopify";

/**
 * Slots Carrie MUST NEVER fabricate — the never-fake-a-customer-result line.
 * These are the only `asset_role` values allowed on a `lander_content_gaps`
 * row (plus `other` as an escape hatch); they route to Max for real-world
 * supply.
 */
export const REAL_EVIDENCE_CATEGORIES = [
  "before_after",
  "ugc",
  "testimonial_photo",
  "press_logo",
] as const satisfies readonly ProductMediaCategory[];

const PRODUCT_MEDIA_CATEGORIES: readonly ProductMediaCategory[] = [
  "before_after",
  "ugc",
  "testimonial_photo",
  "press_logo",
  "lifestyle",
  "hero",
  "ingredient",
  "mechanism",
  "other",
];

const PRODUCT_MEDIA_SOURCES: readonly ProductMediaSource[] = [
  "uploaded",
  "generated",
  "scout",
  "shopify",
];

/**
 * The subset of `product_media` columns Carrie's DR read path cares about.
 * The full row has 40+ responsive-variant columns; loading them all bloats the
 * "do we already have an X for this product?" probe with no upside.
 */
export interface ProductMediaCategorizedRow {
  id: string;
  workspace_id: string;
  product_id: string;
  slot: string;
  url: string | null;
  storage_path: string | null;
  category: ProductMediaCategory | null;
  source: ProductMediaSource | null;
  caption: string | null;
  alt_text: string | null;
  display_order: number;
  created_at: string;
  updated_at: string;
}

export interface WriteCategorizedMediaInput {
  workspace_id: string;
  product_id: string;
  slot: string;
  url: string;
  storage_path?: string | null;
  category: ProductMediaCategory;
  source: ProductMediaSource;
  caption?: string | null;
  alt_text?: string | null;
  width?: number | null;
  height?: number | null;
  mime_type?: string | null;
  display_order?: number;
}

/**
 * Persist a categorized `product_media` row — the Carrie write path. Used by
 * her dr-content session when Nano Banana Pro returns an approved asset (or
 * when the founder resolves a gap by uploading a real-evidence asset).
 *
 * Uses `upsert` on `(workspace_id, product_id, slot, display_order)` to match
 * the existing gallery unique constraint, so re-running the same slot rewrites
 * the row (mirrors `seed-tools.saveMedia`).
 */
export async function writeCategorizedProductMedia(
  input: WriteCategorizedMediaInput,
): Promise<ProductMediaCategorizedRow> {
  if (!PRODUCT_MEDIA_CATEGORIES.includes(input.category)) {
    throw new Error(`writeCategorizedProductMedia: unknown category '${input.category}'`);
  }
  if (!PRODUCT_MEDIA_SOURCES.includes(input.source)) {
    throw new Error(`writeCategorizedProductMedia: unknown source '${input.source}'`);
  }
  if (!input.url) {
    throw new Error("writeCategorizedProductMedia: url is required");
  }
  const admin = createAdminClient();
  const row = {
    workspace_id: input.workspace_id,
    product_id: input.product_id,
    slot: input.slot,
    display_order: input.display_order ?? 0,
    url: input.url,
    storage_path: input.storage_path ?? null,
    category: input.category,
    source: input.source,
    caption: input.caption ?? null,
    alt_text: input.alt_text ?? "",
    width: input.width ?? null,
    height: input.height ?? null,
    mime_type: input.mime_type ?? null,
    uploaded_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await admin
    .from("product_media")
    .upsert(row, { onConflict: "workspace_id,product_id,slot,display_order" })
    .select(
      "id, workspace_id, product_id, slot, url, storage_path, category, source, caption, alt_text, display_order, created_at, updated_at",
    )
    .single();
  if (error) throw new Error(`writeCategorizedProductMedia: ${error.message}`);
  return data as ProductMediaCategorizedRow;
}

/**
 * Read categorized `product_media` for a product — Carrie's "do we already
 * have an X for this product?" probe. Filter by `category` to answer a single
 * slot's question; omit to load every categorized asset for a decision pass.
 */
export async function listCategorizedProductMedia(
  workspaceId: string,
  productId: string,
  filter: { category?: ProductMediaCategory; source?: ProductMediaSource } = {},
): Promise<ProductMediaCategorizedRow[]> {
  const admin = createAdminClient();
  let q = admin
    .from("product_media")
    .select(
      "id, workspace_id, product_id, slot, url, storage_path, category, source, caption, alt_text, display_order, created_at, updated_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);
  if (filter.category) q = q.eq("category", filter.category);
  if (filter.source) q = q.eq("source", filter.source);
  q = q.order("created_at", { ascending: false });
  const { data, error } = await q;
  if (error) throw new Error(`listCategorizedProductMedia: ${error.message}`);
  return (data || []) as ProductMediaCategorizedRow[];
}

/**
 * Asset role for a `lander_content_gaps` row — must be a category Carrie
 * would NEVER ethically generate (plus `other` as an escape hatch). Matches
 * the CHECK constraint on `lander_content_gaps.asset_role`.
 */
export type LanderContentGapAssetRole =
  | "before_after"
  | "ugc"
  | "testimonial_photo"
  | "press_logo"
  | "other";

export type LanderContentGapStatus = "open" | "resolved";

export interface LanderContentGap {
  id: string;
  workspace_id: string;
  blueprint_id: string;
  asset_role: LanderContentGapAssetRole;
  block_ref: string;
  description: string;
  status: LanderContentGapStatus;
  resolved_media_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpenContentGapInput {
  workspace_id: string;
  blueprint_id: string;
  asset_role: LanderContentGapAssetRole;
  /** Which skeleton block on the blueprint needs this asset (matches `skeleton.blocks[].role`). */
  block_ref: string;
  /** Plain-language description written for the FOUNDER — no jargon, no lever names. */
  description: string;
}

const GAP_ASSET_ROLES: readonly LanderContentGapAssetRole[] = [
  "before_after",
  "ugc",
  "testimonial_photo",
  "press_logo",
  "other",
];

/**
 * Carrie opens a gap — one row per real-evidence asset she can't ethically
 * generate. The row is workspace-scoped and blueprint-scoped; on resolve it
 * points at the resolved `product_media` row.
 */
export async function openContentGap(input: OpenContentGapInput): Promise<LanderContentGap> {
  if (!GAP_ASSET_ROLES.includes(input.asset_role)) {
    throw new Error(`openContentGap: unknown asset_role '${input.asset_role}'`);
  }
  if (!input.block_ref) throw new Error("openContentGap: block_ref is required");
  if (!input.description) throw new Error("openContentGap: description is required");
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("lander_content_gaps")
    .insert({
      workspace_id: input.workspace_id,
      blueprint_id: input.blueprint_id,
      asset_role: input.asset_role,
      block_ref: input.block_ref,
      description: input.description,
    })
    .select("*")
    .single();
  if (error) throw new Error(`openContentGap: ${error.message}`);
  return data as LanderContentGap;
}

export interface ListContentGapsFilter {
  blueprint_id?: string;
  status?: LanderContentGapStatus;
  asset_role?: LanderContentGapAssetRole;
  limit?: number;
}

/**
 * List a workspace's content gaps — Carrie reads by `blueprint_id` +
 * `status='open'` to decide the blueprint status transition; Max's inbox
 * reads by workspace + `status='open'`.
 */
export async function listContentGaps(
  workspaceId: string,
  filter: ListContentGapsFilter = {},
): Promise<LanderContentGap[]> {
  const admin = createAdminClient();
  let q = admin.from("lander_content_gaps").select("*").eq("workspace_id", workspaceId);
  if (filter.blueprint_id) q = q.eq("blueprint_id", filter.blueprint_id);
  if (filter.status) q = q.eq("status", filter.status);
  if (filter.asset_role) q = q.eq("asset_role", filter.asset_role);
  q = q.order("created_at", { ascending: false }).limit(filter.limit ?? 200);
  const { data, error } = await q;
  if (error) throw new Error(`listContentGaps: ${error.message}`);
  return (data || []) as LanderContentGap[];
}

/**
 * Founder / operator resolves a gap after supplying the real-evidence asset.
 * `resolvedMediaId` must be an existing `product_media` row (the just-uploaded
 * DR asset). Idempotent — resolving an already-resolved gap re-points it.
 */
export async function resolveContentGap(
  workspaceId: string,
  gapId: string,
  resolvedMediaId: string,
): Promise<void> {
  if (!resolvedMediaId) throw new Error("resolveContentGap: resolvedMediaId is required");
  const admin = createAdminClient();
  const { error } = await admin
    .from("lander_content_gaps")
    .update({ status: "resolved", resolved_media_id: resolvedMediaId })
    .eq("id", gapId)
    .eq("workspace_id", workspaceId);
  if (error) throw new Error(`resolveContentGap: ${error.message}`);
}
