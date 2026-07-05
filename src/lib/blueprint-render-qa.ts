/**
 * Phase-3 render QA for the "build the {slug} lander" spec chain — pure
 * predicate over a blueprint + its resolved render content. Answers three
 * questions with evidence, so the paired script's dry-run tells the operator
 * exactly which block/asset is off before any UPDATE fires:
 *
 *   1. Byte-identical copy per block — the render content's `blocks[i].copy`
 *      must equal `lander_blueprints.content.blocks[i].copy` for every block
 *      (indexing parallel, no reorder, no whitespace normalization).
 *   2. Every image slot maps to a real product_media row — a block whose
 *      role infers an image slot (hero / testimonial / etc.) must have
 *      resolved a non-null URL through the same reader the storefront renders
 *      with. A null there is a broken asset.
 *   3. Structural parity — same number of blocks in `blueprint.content.blocks`
 *      and the resolved render (catches a truncation / off-by-one that would
 *      only be visible on the live page).
 *
 * READ-ONLY. The snapshot write is in [[lander-blueprints]]
 * `setBlueprintRenderedUrl` — this file never mutates. Called from
 * `scripts/qa-and-snapshot-blueprint-render.ts`.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { loadBlueprintRenderContent } from "@/lib/blueprint-render";
import type { LanderBlueprint } from "@/lib/lander-blueprints";

/** One issue the QA found. Non-empty `issues[]` means the QA fails. */
export interface BlueprintRenderQaIssue {
  kind: "copy_mismatch" | "missing_image" | "block_count_mismatch" | "content_missing" | "load_failed";
  blockIndex: number | null;
  role: string | null;
  detail: string;
}

export interface BlueprintRenderQaReport {
  blueprintId: string;
  workspaceId: string;
  productId: string;
  funnelType: string;
  ok: boolean;
  blockCount: number;
  imageBlockCount: number;
  issues: BlueprintRenderQaIssue[];
}

/**
 * Same "does this block role carry an image slot" heuristic the render reader
 * uses (`inferMediaCategoryForBlock`). Duplicated intentionally: keeping the
 * QA's predicate INDEPENDENT of the render's classifier catches a drift where
 * the render silently stopped resolving a slot the blueprint expected filled.
 */
function blockExpectsImage(role: string): boolean {
  const r = role.toLowerCase();
  return (
    r.includes("hero") ||
    r.includes("testimonial") ||
    r.includes("ugc") ||
    (r.includes("before") && r.includes("after")) ||
    r.includes("press") ||
    r.includes("lifestyle") ||
    r.includes("ingredient")
  );
}

/**
 * Run the Phase-3 render QA against a single blueprint. Returns a report
 * whose `ok` flag is true iff every block's copy is byte-identical AND every
 * image-carrying block resolved a URL AND the structural counts line up.
 *
 * Any load / DB failure is captured as an issue (never thrown) so the caller
 * can print the report + decide whether to snapshot the rendered URL. The
 * snapshot is the caller's responsibility — a failed QA MUST NOT stamp a
 * rendered URL onto the blueprint (would advertise a broken page).
 */
export async function runBlueprintRenderQa(
  workspaceId: string,
  blueprintId: string,
): Promise<BlueprintRenderQaReport> {
  const admin = createAdminClient();
  const { data: row, error: bpErr } = await admin
    .from("lander_blueprints")
    .select("id, workspace_id, product_id, funnel_type, content")
    .eq("id", blueprintId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const base: BlueprintRenderQaReport = {
    blueprintId,
    workspaceId,
    productId: "",
    funnelType: "",
    ok: false,
    blockCount: 0,
    imageBlockCount: 0,
    issues: [],
  };
  if (bpErr) {
    base.issues.push({
      kind: "load_failed",
      blockIndex: null,
      role: null,
      detail: `blueprint read failed: ${bpErr.message}`,
    });
    return base;
  }
  if (!row) {
    base.issues.push({
      kind: "load_failed",
      blockIndex: null,
      role: null,
      detail: `blueprint ${blueprintId} not found in workspace ${workspaceId}`,
    });
    return base;
  }
  const bp = row as Pick<LanderBlueprint, "id" | "workspace_id" | "product_id" | "funnel_type" | "content">;
  base.productId = bp.product_id;
  base.funnelType = bp.funnel_type;

  const content = bp.content;
  if (!content || !Array.isArray(content.blocks) || content.blocks.length === 0) {
    base.issues.push({
      kind: "content_missing",
      blockIndex: null,
      role: null,
      detail: `blueprint ${blueprintId} has no content.blocks — QA can't run against an empty content payload`,
    });
    return base;
  }

  let render: Awaited<ReturnType<typeof loadBlueprintRenderContent>>;
  try {
    render = await loadBlueprintRenderContent(bp.workspace_id, bp.product_id, bp.funnel_type);
  } catch (err) {
    base.issues.push({
      kind: "load_failed",
      blockIndex: null,
      role: null,
      detail: `loadBlueprintRenderContent threw: ${(err as Error).message}`,
    });
    return base;
  }
  if (!render) {
    base.issues.push({
      kind: "load_failed",
      blockIndex: null,
      role: null,
      detail: `loadBlueprintRenderContent returned null (no content-filled blueprint for (${bp.workspace_id}, ${bp.product_id}, ${bp.funnel_type}))`,
    });
    return base;
  }

  base.blockCount = content.blocks.length;
  base.imageBlockCount = content.blocks.filter((b) => blockExpectsImage(b.role)).length;

  if (render.blocks.length !== content.blocks.length) {
    base.issues.push({
      kind: "block_count_mismatch",
      blockIndex: null,
      role: null,
      detail: `blueprint.content.blocks has ${content.blocks.length} entries; render returned ${render.blocks.length}`,
    });
  }

  const parallelLen = Math.min(content.blocks.length, render.blocks.length);
  for (let i = 0; i < parallelLen; i += 1) {
    const src = content.blocks[i];
    const dst = render.blocks[i];
    if (src.copy !== dst.copy) {
      base.issues.push({
        kind: "copy_mismatch",
        blockIndex: i,
        role: src.role,
        detail: `block ${i} (role='${src.role}'): render copy diverges from blueprint copy`,
      });
    }
    if (blockExpectsImage(src.role) && !dst.imageUrl) {
      base.issues.push({
        kind: "missing_image",
        blockIndex: i,
        role: src.role,
        detail: `block ${i} (role='${src.role}'): image-carrying block resolved no product_media URL`,
      });
    }
  }

  base.ok = base.issues.length === 0;
  return base;
}
