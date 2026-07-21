/**
 * Deterministic verify + build-spec handoff — Phase 2 of
 * docs/brain/specs/content-upload-and-lander-build.md.
 *
 * Runs when a [[lander-blueprints]] row hits `content_complete` (from the founder-facing
 * upload surface, or a scheduled cadence). Two decision paths, both deterministic — no
 * Anthropic API, no session:
 *
 *   • PASS (bucket is whole) — every skeleton block has copy in `content` AND every
 *     image slot on the blueprint is filled (a resolved [[lander-content-gaps]] row or a
 *     `product_media` row categorized to the block's role). Author a lander BUILD spec via
 *     [[author-spec]] `authorSpecRowStructured` (owner `growth`, one phase per storefront
 *     lander build step), flip the blueprint → `build_submitted`, link the spec slug via
 *     [[lander-blueprints]] `setBlueprintBuildSubmission`. The normal build pipeline
 *     (Vale → Ada → Bo) takes it from there.
 *
 *   • INCOMPLETE — at least one block/image slot is missing. Revert the blueprint to
 *     `awaiting_upload` and RE-OPEN the missing item as a [[lander-content-gaps]] row so
 *     the founder surface re-surfaces it. Never authors a spec — an incomplete blueprint
 *     never reaches Ada.
 *
 * Chokepoint discipline: every WRITE goes through [[lander-blueprints]] SDK + the
 * [[author-spec]] chokepoint. No raw `.from('lander_blueprints'|'lander_content_gaps'|'specs')`
 * insert/update outside those SDKs.
 *
 * North-star (supervisable autonomy): the decision is deterministic — nothing runs silently
 * and every branch's rationale surfaces on the blueprint (`build_submitted` + linked spec on
 * pass; `awaiting_upload` + re-opened gaps on fail).
 */
import {
  getBlueprint,
  listContentGaps,
  listCategorizedProductMedia,
  openContentGap,
  setBlueprintBuildSubmission,
  setBlueprintStatus,
  type LanderBlueprint,
  type LanderBlueprintBlock,
  type LanderContentGapAssetRole,
} from "@/lib/lander-blueprints";
import { errText } from "@/lib/error-text";
import { authorSpecRowStructured, type StructuredPhaseInput, type StructuredSpecInput } from "@/lib/author-spec";
import { listBlueprints } from "@/lib/lander-blueprints";

/** One missing item on a blueprint's `content` — either a block with no copy OR an image slot with no filled asset. */
export interface BlueprintDeficit {
  kind: "missing_copy" | "missing_image";
  block_role: string;
  /** Human-readable description of what's missing — becomes the founder-facing gap description on revert. */
  description: string;
  /** For `missing_image`: the persuasive-job asset_role Cleo picked for the block, so the reverted gap
   * routes to the correct real-evidence category (before_after / ugc / testimonial_photo / press_logo /
   * other). For `missing_copy` this is `null`. */
  asset_role: LanderContentGapAssetRole | null;
}

/** Deterministic verify result — pure over the blueprint + gap/media inputs, no I/O. */
export interface BlueprintVerifyResult {
  ok: boolean;
  deficits: BlueprintDeficit[];
}

/** The set of asset roles a block SHOULD have covered — same vocabulary as the gap
 * asset_roles (real-evidence categories Carrie can't fabricate). `null` when the block's
 * `role` doesn't parse to a real-evidence hint (a copy-only block like `hero-copy`). */
function inferAssetRoleForBlock(block: LanderBlueprintBlock): LanderContentGapAssetRole | null {
  const role = String(block.role || "").toLowerCase();
  // The block's role is Rhea's chapter role name — it's fuzzy on purpose. Match on
  // substrings so `reason-1-before-after` still routes to before_after.
  if (role.includes("before_after") || role.includes("before-after") || role.includes("beforeafter")) return "before_after";
  if (role.includes("ugc") || role.includes("selfie")) return "ugc";
  if (role.includes("testimonial")) return "testimonial_photo";
  if (role.includes("press") || role.includes("logo") || role.includes("certification")) return "press_logo";
  return null;
}

/** Does this block NEED an image? Fuzzy — if the block's role or its `notes` hint at an
 * image slot (any of the real-evidence roles, or an explicit `image` mention) treat it as
 * needing one. Copy-only blocks (headline / body / cta) return false so they don't spawn
 * ghost image gaps. */
export function blockNeedsImage(block: LanderBlueprintBlock): boolean {
  const surface = `${block.role || ""} ${block.notes || ""}`.toLowerCase();
  if (inferAssetRoleForBlock(block) !== null) return true;
  if (surface.includes("hero")) return true;
  if (surface.includes("image")) return true;
  if (surface.includes("photo")) return true;
  if (surface.includes("visual")) return true;
  return false;
}

/**
 * Pure verify — every skeleton block has non-empty copy in `content.blocks`, AND every
 * image-slot block is covered by either a resolved gap on that block_ref OR a categorized
 * `product_media` row keyed to the block's asset_role. `blocksWithResolvedGap` is the set
 * of `skeleton.blocks[].role` values already resolved via a `lander_content_gaps` row;
 * `productMediaCategories` is the set of `product_media.category` values already on the
 * product. Deficits are the ordered list of what's missing.
 */
export function verifyBlueprintBucket(
  blueprint: LanderBlueprint,
  blocksWithResolvedGap: ReadonlySet<string>,
  productMediaCategories: ReadonlySet<string>,
): BlueprintVerifyResult {
  const deficits: BlueprintDeficit[] = [];
  const blocks = blueprint.skeleton?.blocks || [];
  const contentByRole = new Map<string, string>();
  for (const c of blueprint.content?.blocks || []) contentByRole.set(String(c.role || "").trim(), (c.copy || "").trim());

  for (const block of blocks) {
    const role = String(block.role || "").trim();
    if (!role) continue;
    const copy = contentByRole.get(role) || "";
    if (!copy) {
      deficits.push({
        kind: "missing_copy",
        block_role: role,
        description: `Copy is missing for the '${role}' block. Carrie needs to fill it before this lander can build.`,
        asset_role: null,
      });
    }
    if (blockNeedsImage(block)) {
      const assetRole = inferAssetRoleForBlock(block) || "other";
      const covered = blocksWithResolvedGap.has(role) || productMediaCategories.has(assetRole);
      if (!covered) {
        deficits.push({
          kind: "missing_image",
          block_role: role,
          asset_role: assetRole,
          description: `The '${role}' block needs a ${assetRole.replace(/_/g, " ")} image — upload one so the block can render.`,
        });
      }
    }
  }
  return { ok: deficits.length === 0, deficits };
}

/**
 * Deterministic build-spec content — one phase per storefront lander build step. Compact by
 * design (Ada reads the same spec that Cleo authored, and the build pipeline treats each
 * bullet as a task). The bodies embed the blueprint's skeleton + Carrie's copy inline so the
 * builder never has to fetch the blueprint row to read them.
 */
function slugifyForSpec(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

interface SkeletonSummaryLine {
  role: string;
  purpose: string;
  copyPreview: string;
  needsImage: boolean;
  assetRole: LanderContentGapAssetRole | null;
}

function summarizeSkeleton(blueprint: LanderBlueprint): SkeletonSummaryLine[] {
  const blocks = blueprint.skeleton?.blocks || [];
  const contentByRole = new Map<string, string>();
  for (const c of blueprint.content?.blocks || []) contentByRole.set(String(c.role || "").trim(), (c.copy || "").trim());
  return blocks.map((b) => {
    const copy = contentByRole.get(String(b.role || "").trim()) || "";
    return {
      role: String(b.role || "").trim(),
      purpose: String(b.purpose || "").trim(),
      copyPreview: copy.length > 220 ? `${copy.slice(0, 220)}…` : copy,
      needsImage: blockNeedsImage(b),
      assetRole: inferAssetRoleForBlock(b),
    };
  });
}

function renderSkeletonSection(summary: SkeletonSummaryLine[]): string {
  if (!summary.length) return "_(blueprint carries no skeleton blocks — Ada should investigate.)_";
  return summary
    .map((s, i) => {
      const image = s.needsImage
        ? `\n  - Image slot: ${s.assetRole ? `${s.assetRole} (from resolved gap or product_media)` : "hero/lifestyle (already on product_media)"}`
        : "";
      const copy = s.copyPreview ? `\n  - Copy: ${s.copyPreview}` : "";
      return `- **${i + 1}. ${s.role}** — ${s.purpose}${copy}${image}`;
    })
    .join("\n");
}

interface BuildSpecArtifact {
  slug: string;
  input: StructuredSpecInput;
}

/**
 * Author the deterministic build spec off a verified blueprint. The spec is one owner
 * (`growth`), one parent (Growth's "Ad-matched landing pages" mandate — Cleo's scent-matched
 * lander build is perpetual acquisition work, so it anchors on the mandate rather than a
 * finite goal milestone), and three phases mirroring the storefront lander build steps: build
 * the addressable page + wire it as an ad destination, owner-gated preview, and a fold-once-
 * live pass. Slug is `lander-build-{funnel}-{product}-{shortid}` — collision-safe by embedding
 * the blueprint id's tail.
 */
export function composeBuildSpec(blueprint: LanderBlueprint, productTitle: string, productHandle: string | null): BuildSpecArtifact {
  const funnelSlug = slugifyForSpec(blueprint.funnel_type || "lander");
  const productSlug = slugifyForSpec(productHandle || productTitle || blueprint.product_id);
  const idTail = blueprint.id.replace(/-/g, "").slice(0, 8);
  const slug = `lander-build-${funnelSlug}-${productSlug}-${idTail}`.slice(0, 96);

  const skeleton = summarizeSkeleton(blueprint);
  const skeletonMd = renderSkeletonSection(skeleton);
  const rationale = blueprint.rationale?.trim() || "(no rationale recorded)";
  const ctaCopy = blueprint.content?.cta?.trim() || "";

  const specWhy = `Cleo's teardown → build-new blueprint for ${productTitle} is content-complete (every skeleton block has copy + every real-evidence image slot is filled). Ship the addressable ${blueprint.funnel_type} lander so Growth has a new ad destination beyond the PDP.`;
  const specWhat = `A new addressable storefront lander for ${productTitle} rendering the ${blueprint.funnel_type} skeleton with Carrie's copy + the resolved product_media assets, wired as an ad destination via the storefront-optimizer-agent surfaces (owner-gated preview URL and public ?variant= route), plus a first-render QA pass before Growth points ads at it.`;

  const summary = `**Brain refs:** [[../libraries/lander-blueprints]] · [[../libraries/storefront-optimizer-agent]] · [[../tables/product_media]]

Build the ${productTitle} ${blueprint.funnel_type} lander from lander_blueprints.id \`${blueprint.id}\`. Cleo authored this spec deterministically after the blueprint's bucket was verified whole (content-upload-and-lander-build Phase 2). Rationale from Cleo: ${rationale}`;

  const phaseRender: StructuredPhaseInput = {
    title: "Render the skeleton on the storefront",
    why: `The blueprint carries Carrie's copy + resolved product_media refs for every block; nothing else in the org holds this content, so Growth can't A/B against Rhea's teardown until Ada renders it as a real page.`,
    what: `A new storefront lander route that renders the ${blueprint.funnel_type} skeleton block-by-block with Carrie's copy + the categorized product_media assets (source='uploaded' resolves gaps, source='generated'/'shopify' fills copy-only image slots). Addressable at the product's ?variant= URL like our existing landers.`,
    body:
      `Render the blueprint's skeleton as an addressable storefront lander for ${productTitle} (handle \`${productHandle ?? "?"}\`). The blueprint id is \`${blueprint.id}\` (funnel type: \`${blueprint.funnel_type}\`).\n\n` +
      `Skeleton to render, in order:\n${skeletonMd}\n\n` +
      (ctaCopy ? `Overall CTA copy: ${ctaCopy}\n\n` : "") +
      `Wire the page as an addressable storefront lander (an ad destination, like our existing ?variant= landers via [[../libraries/storefront-optimizer-agent]] surfaces — see \`src/lib/storefront/experiments.ts\` for the current mapping between storefront_experiments.lander_type and the render ?variant=). Read block copy from lander_blueprints.content and image assets from product_media rows keyed to the blueprint's product_id (resolved gaps take precedence; fall back to any categorized product_media in the block's asset role).`,
    verification:
      `- The new page renders every skeleton block in order with Carrie's copy visible.\n` +
      `- Real-evidence image slots render the resolved product_media asset (source='uploaded').\n` +
      `- The page is reachable at the addressable ?variant= URL matching lander_blueprints.funnel_type.\n` +
      `- No console errors on first render; Lighthouse LCP < 2.5s on a fast connection.\n` +
      `- tsc clean.`,
  };

  const phasePreview: StructuredPhaseInput = {
    title: "Owner-gated preview + storefront_experiments wiring",
    why: `The lander must be reviewable by the founder before public ads point at it — the owner-gated preview is the same discipline every ?variant= lander uses today. Wiring the storefront_experiments row is how the campaign-grader + optimizer see it.`,
    what: `An owner-gated preview URL for the new lander plus a matching storefront_experiments row (product_id + lander_type derived from the blueprint) so the optimizer/campaign-grader picks it up and Growth can A/B against the base PDP.`,
    body:
      `Add the owner-gated preview URL and a matching storefront_experiments row so Growth can point ads at the new lander through the existing bandit surface. Blueprint id: \`${blueprint.id}\`.\n\n` +
      `1. Owner-gate a \`?preview=1\` variant of the render so only workspace_members.role='owner' can view a not-yet-public lander (mirror the existing owner-gated preview on our other ?variant= landers).\n` +
      `2. Insert a storefront_experiments row (product_id = blueprint.product_id, lander_type mapped from blueprint.funnel_type via \`mapFunnelTypeToLanderType\`) so the optimizer + campaign-grader see the new lander.\n` +
      `3. Link back to the blueprint (lander_blueprints.build_spec_slug already points at THIS spec — round-trip visibility).`,
    verification:
      `- Owner sees the lander at the preview URL; a non-owner is 403'd until the row is promoted.\n` +
      `- A new storefront_experiments row exists for (product_id, lander_type) with the new lander wired in.\n` +
      `- The optimizer's next tick includes the new lander in its candidate set.\n` +
      `- tsc clean.`,
  };

  const phaseQA: StructuredPhaseInput = {
    title: "First-render QA + fold to brain",
    why: `A first-render QA catches copy/media mismatches before ad spend fires; folding the lander into the brain (dashboard/lifecycle pages) preserves the source teardown → blueprint → build chain for future readers.`,
    what: `A QA pass on the rendered lander (copy matches blueprint.content, real-evidence images match their block_ref) plus a brain-page fold noting the finished lander under the acquisition-research-engine lifecycle.`,
    body:
      `QA the first render + fold the finished lander into the brain.\n\n` +
      `1. QA — verify every block on the rendered page matches lander_blueprints.content (no missing copy, no swapped assets). Snapshot the rendered URL onto the blueprint for record.\n` +
      `2. Fold — extend the acquisition-research-engine lifecycle brain page with the finished blueprint's story (source teardown → blueprint slug → build spec → live URL). Cross-link [[../libraries/lander-blueprints]] and [[../libraries/storefront-optimizer-agent]].`,
    verification:
      `- Rendered page copy is byte-identical to blueprint.content.blocks[i].copy for every block.\n` +
      `- Every image slot on the rendered page maps to a real product_media row (no broken assets).\n` +
      `- The lifecycle brain page includes the finished lander with the chain intact.\n` +
      `- tsc clean.`,
  };

  const input: StructuredSpecInput = {
    title: `Build the ${productTitle} ${blueprint.funnel_type} lander from Cleo's blueprint`,
    summary,
    owner: "growth",
    parent: `[[../functions/growth]] — "Ad-matched landing pages" mandate: ${productTitle} ${blueprint.funnel_type} lander build.`,
    why: specWhy,
    what: specWhat,
    phases: [phaseRender, phasePreview, phaseQA],
    autoBuild: true,
  };
  return { slug, input };
}

export interface SubmitOutcome {
  status: "submitted" | "reverted" | "no_action" | "error";
  blueprint_id: string;
  build_spec_slug?: string;
  deficits?: BlueprintDeficit[];
  reason?: string;
}

/**
 * Verify one blueprint and act. Deterministic + idempotent — a repeat call against an already-
 * submitted blueprint is a no-op (returns `no_action`). Never authors a spec on an incomplete
 * bucket; instead reverts to `awaiting_upload` and re-opens gaps for the missing items.
 *
 * The caller (upload route on the last resolve, or a scheduled sweep) hands the blueprint id
 * and product context; this function does the rest — verify → author-spec chokepoint OR revert.
 */
export async function verifyAndSubmitBlueprint(
  workspaceId: string,
  blueprintId: string,
): Promise<SubmitOutcome> {
  const blueprint = await getBlueprint(workspaceId, blueprintId);
  if (!blueprint) return { status: "no_action", blueprint_id: blueprintId, reason: "blueprint not found" };
  if (blueprint.status === "build_submitted") {
    return { status: "no_action", blueprint_id: blueprintId, reason: "already submitted", build_spec_slug: blueprint.build_spec_slug || undefined };
  }
  if (blueprint.status !== "content_complete") {
    return { status: "no_action", blueprint_id: blueprintId, reason: `blueprint status is '${blueprint.status}' — verify only runs on 'content_complete'` };
  }

  // Load the resolved-gap set + the product_media categories already covered.
  const [resolvedGaps, media] = await Promise.all([
    listContentGaps(workspaceId, { blueprint_id: blueprint.id, status: "resolved" }),
    listCategorizedProductMedia(workspaceId, blueprint.product_id),
  ]);
  const blocksWithResolvedGap = new Set<string>();
  for (const g of resolvedGaps) blocksWithResolvedGap.add(String(g.block_ref || "").trim());
  const productMediaCategories = new Set<string>();
  for (const m of media) if (m.category) productMediaCategories.add(m.category);

  const verify = verifyBlueprintBucket(blueprint, blocksWithResolvedGap, productMediaCategories);

  if (!verify.ok) {
    // Revert to awaiting_upload + re-open a gap for every MISSING IMAGE (missing copy is Carrie's
    // job — reverting to awaiting_upload re-queues her Phase 1 flow; a gap row here would confuse
    // the founder-facing upload surface).
    await setBlueprintStatus(workspaceId, blueprint.id, "awaiting_upload");
    for (const d of verify.deficits) {
      if (d.kind === "missing_image" && d.asset_role) {
        try {
          await openContentGap({
            workspace_id: workspaceId,
            blueprint_id: blueprint.id,
            asset_role: d.asset_role,
            block_ref: d.block_role,
            description: d.description,
          });
        } catch (e) {
          console.warn(`[blueprint-build-submit] re-open gap failed for blueprint ${blueprint.id} block ${d.block_role}:`, e instanceof Error ? e.message : e);
        }
      }
    }
    return { status: "reverted", blueprint_id: blueprint.id, deficits: verify.deficits, reason: "bucket incomplete — reverted to awaiting_upload with missing items re-opened as gaps" };
  }

  // PASS — author the build spec through the author-spec chokepoint, then flip status + link the slug.
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: product } = await admin
    .from("products")
    .select("title, handle")
    .eq("workspace_id", workspaceId)
    .eq("id", blueprint.product_id)
    .maybeSingle();
  const productTitle = (product as { title: string | null; handle: string | null } | null)?.title || "the target product";
  const productHandle = (product as { title: string | null; handle: string | null } | null)?.handle || null;

  const { slug, input } = composeBuildSpec(blueprint, productTitle, productHandle);
  const authored = await authorSpecRowStructured(workspaceId, slug, input, "planned", {
    intendedStatusSetBy: "cleo:content-upload-and-lander-build",
    // Cleo's scent-matched lander builds are perpetual acquisition work — anchor on Growth's
    // "Ad-matched landing pages" mandate, not a finite goal milestone. The goal planner can
    // still attach a milestone_id separately later if a specific goal wants to claim this
    // spec; the mandate parent is the durable anchor Vale checks.
    parentKind: "mandate",
    parentRef: "growth#ad-matched-landing-pages",
  });
  if (!authored) {
    return { status: "error", blueprint_id: blueprint.id, reason: `authorSpecRowStructured returned false for slug ${slug}` };
  }

  await setBlueprintBuildSubmission(workspaceId, blueprint.id, slug);
  return { status: "submitted", blueprint_id: blueprint.id, build_spec_slug: slug };
}

/**
 * Cadence sweep — scan every workspace's `content_complete` blueprints and drive each
 * through `verifyAndSubmitBlueprint`. Belt-and-suspenders for the direct call from the
 * upload route: if a blueprint hit content_complete during a failed upload retry (the
 * status flip landed but the direct verify+handoff hiccuped), the sweep picks it up on
 * the next tick.
 */
export async function runBlueprintBuildSubmitSweep(
  workspaceId: string,
  opts: { limit?: number } = {},
): Promise<SubmitOutcome[]> {
  const rows = await listBlueprints(workspaceId, { status: "content_complete", limit: opts.limit ?? 50 });
  const out: SubmitOutcome[] = [];
  for (const b of rows) {
    try {
      out.push(await verifyAndSubmitBlueprint(workspaceId, b.id));
    } catch (e) {
      out.push({ status: "error", blueprint_id: b.id, reason: errText(e) });
    }
  }
  return out;
}
