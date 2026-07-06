/**
 * Storefront reader for a [[lander_blueprints]] row rendered as an addressable
 * lander — Phase 1 of the "build the {slug} lander" specs authored off a
 * blueprint (see e.g. docs/brain/specs/lander-build-advertorial-listicle-amazing-coffee-23e0ea01.md).
 *
 * A blueprint is a whole-missing-funnel-type recipe (11+ blocks of copy + image
 * slots) Cleo authored off a worthy teardown and Carrie filled with per-block
 * copy + image asset assignments. When the funnel_type is `advertorial-listicle`
 * (or any other funnel our storefront can't render via the existing three
 * ?variant= landers), the storefront exposes it at
 * `?variant=<funnel_type>` and this reader resolves the copy + image URLs the
 * render section iterates over.
 *
 * Resolution order per block:
 *   1. `content.blocks[i].assets[0].ref` — if Carrie wrote an explicit URL.
 *   2. Resolved [[lander_content_gaps]] where `block_ref = block.role` — the
 *      founder-uploaded real-evidence asset (testimonial photo, before/after,
 *      UGC selfie, press logo).
 *   3. Categorized [[product_media]] by inferred category (hero / lifestyle for
 *      the hero block, testimonial_photo for a testimonials block).
 *
 * Read-only (like [[advertorial-pages]] `loadAdvertorialContent`) — the SDK
 * writes stay in [[lander-blueprints]].
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  LanderBlueprint,
  LanderBlueprintContentBlock,
  ProductMediaCategory,
} from "@/lib/lander-blueprints";

/** One block ready for the render: original role + copy + optionally a resolved image. */
export interface BlueprintRenderBlock {
  role: string;
  copy: string;
  imageUrl: string | null;
  imageAlt: string | null;
}

/** Discrete, composited-hero fields (the "8 Reasons…" top fold). Authored on
 *  `lander_blueprints.content.hero` — distinct from the copy blocks so the hero renders as a
 *  real composition, not a stacked copy blob. Null when a blueprint has no structured hero yet. */
export interface BlueprintHeroData {
  brand: string;
  headline: string;
  reviewCount: string;
  /** Static urgency, no season word — e.g. "65% Off — Ends Soon". */
  urgency: string;
  quote: { text: string; name: string; title: string; avatarUrl: string | null };
  offer: { discount: string; base: string; subtext: string; heading: string };
  heroImageUrl: string;
  ctaLabel: string;
}

/** One "reason" row (image + numbered headline + copy + CTA). Authored on
 *  `lander_blueprints.content.reasons` — the grouped reason copy blocks split into discrete rows. */
export interface ReasonItem {
  n: number;
  headline: string;
  copy: string;
  imageUrl: string | null;
  imageAlt: string | null;
}

/** The intro/proof band's lander-specific bits (mechanism image + product description). The
 *  press logos, press quote, and review widget are reused from PageData, not stored here. */
export interface IntroData {
  imageUrl: string | null;
  imageAlt: string | null;
  description: string;
}

/** Everything the storefront blueprint-lander section needs to render. */
export interface BlueprintRenderContent {
  blueprintId: string;
  productId: string;
  funnelType: string;
  /** Composited hero fields, when the blueprint carries a structured `content.hero`. */
  hero: BlueprintHeroData | null;
  /** Intro/proof band (mechanism image + product description), when `content.intro` is set. */
  intro: IntroData | null;
  /** The 8 discrete reason rows, when the blueprint carries a structured `content.reasons`. */
  reasons: ReasonItem[] | null;
  blocks: BlueprintRenderBlock[];
  /** Overall CTA copy authored by Carrie on `content.cta`. */
  cta: string | null;
}

/**
 * Infer the `product_media.category` that satisfies a given skeleton block's
 * image slot when no explicit ref / resolved gap was set. Cheap heuristic on
 * the block's `role` string — a `testimonials`/`ugc` block wants a real
 * customer photo; a `hero` block wants the hero/lifestyle shot. Returns null
 * when a block isn't image-carrying (offer, faq, footer, recap).
 */
function inferMediaCategoryForBlock(role: string): ProductMediaCategory | null {
  const r = role.toLowerCase();
  if (r.includes("hero")) return "hero";
  if (r.includes("testimonial") || r.includes("ugc")) return "testimonial_photo";
  if (r.includes("before") && r.includes("after")) return "before_after";
  if (r.includes("press")) return "press_logo";
  if (r.includes("lifestyle")) return "lifestyle";
  if (r.includes("ingredient")) return "ingredient";
  return null;
}

/** Resolve one block's image URL — content.assets → resolved gap → categorized media. */
function resolveBlockImage(
  block: LanderBlueprintContentBlock,
  gapsByRole: Map<string, { url: string | null; alt: string | null }>,
  mediaByCategory: Map<ProductMediaCategory, { url: string | null; alt: string | null }>,
): { url: string | null; alt: string | null } {
  const explicit = (block.assets || []).find((a) => a.ref && /^https?:\/\//i.test(a.ref));
  if (explicit) return { url: explicit.ref, alt: block.role };

  const gap = gapsByRole.get(block.role);
  if (gap?.url) return gap;

  const cat = inferMediaCategoryForBlock(block.role);
  if (cat) {
    const media = mediaByCategory.get(cat);
    if (media?.url) return media;
    if (cat === "hero") {
      const lifestyle = mediaByCategory.get("lifestyle");
      if (lifestyle?.url) return lifestyle;
    }
  }
  return { url: null, alt: null };
}

/**
 * Load a blueprint's rendered content for the storefront lander. Returns null
 * when: the blueprint doesn't exist, its `content` hasn't been filled by
 * Carrie yet, or the workspace / product mismatch. The route caller renders a
 * 404 in that case — a blueprint that isn't `content_complete` shouldn't be
 * publicly reachable.
 *
 * @param workspaceId scope guard (workspace-scoped like every other blueprint SDK read)
 * @param productId matches [[lander_blueprints]].product_id
 * @param funnelType matches [[lander_blueprints]].funnel_type — the ?variant= value the URL carries
 */
export async function loadBlueprintRenderContent(
  workspaceId: string,
  productId: string,
  funnelType: string,
): Promise<BlueprintRenderContent | null> {
  const admin = createAdminClient();

  const { data: bpRow, error: bpErr } = await admin
    .from("lander_blueprints")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("funnel_type", funnelType)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (bpErr) throw new Error(`loadBlueprintRenderContent: ${bpErr.message}`);
  const blueprint = bpRow as LanderBlueprint | null;
  if (!blueprint) return null;
  const content = blueprint.content;
  if (!content || !Array.isArray(content.blocks) || content.blocks.length === 0) return null;

  const { data: gapRows } = await admin
    .from("lander_content_gaps")
    .select("block_ref, status, resolved_media_id")
    .eq("workspace_id", workspaceId)
    .eq("blueprint_id", blueprint.id)
    .eq("status", "resolved");

  const resolvedMediaIds = ((gapRows || []) as Array<{
    block_ref: string;
    resolved_media_id: string | null;
  }>)
    .map((g) => g.resolved_media_id)
    .filter((id): id is string => !!id);

  const mediaById = new Map<string, { url: string | null; alt: string | null }>();
  if (resolvedMediaIds.length > 0) {
    const { data: mediaRows } = await admin
      .from("product_media")
      .select("id, url, alt_text")
      .in("id", resolvedMediaIds);
    for (const row of (mediaRows || []) as Array<{ id: string; url: string | null; alt_text: string | null }>) {
      mediaById.set(row.id, { url: row.url, alt: row.alt_text });
    }
  }

  const gapsByRole = new Map<string, { url: string | null; alt: string | null }>();
  for (const g of (gapRows || []) as Array<{ block_ref: string; resolved_media_id: string | null }>) {
    if (!g.resolved_media_id) continue;
    const media = mediaById.get(g.resolved_media_id);
    if (media) gapsByRole.set(g.block_ref, media);
  }

  const { data: catRows } = await admin
    .from("product_media")
    .select("category, url, alt_text, display_order, created_at")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .not("category", "is", null)
    .not("url", "is", null)
    .order("display_order", { ascending: true })
    .order("created_at", { ascending: false });
  const mediaByCategory = new Map<ProductMediaCategory, { url: string | null; alt: string | null }>();
  for (const row of (catRows || []) as Array<{
    category: ProductMediaCategory | null;
    url: string | null;
    alt_text: string | null;
  }>) {
    if (!row.category) continue;
    if (mediaByCategory.has(row.category)) continue;
    mediaByCategory.set(row.category, { url: row.url, alt: row.alt_text });
  }

  const blocks: BlueprintRenderBlock[] = content.blocks.map((b) => {
    const img = resolveBlockImage(b, gapsByRole, mediaByCategory);
    return {
      role: b.role,
      copy: b.copy,
      imageUrl: img.url,
      imageAlt: img.alt,
    };
  });

  return {
    blueprintId: blueprint.id,
    productId,
    funnelType: blueprint.funnel_type,
    hero: (content as { hero?: BlueprintHeroData }).hero ?? null,
    intro: (content as { intro?: IntroData }).intro ?? null,
    reasons: (content as { reasons?: ReasonItem[] }).reasons ?? null,
    blocks,
    cta: content.cta ?? null,
  };
}
