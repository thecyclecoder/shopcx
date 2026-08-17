/**
 * amazon/pack-dimensions — resolve a product's REAL printed pack size from the Amazon catalog and
 * land it on `product_variants.package_{width,height,depth}_mm`, where the ad renderer reads it
 * ([[../ads/creative-generate]] `formatPackageDimensionsClause`).
 *
 * WHY this exists (CEO 2026-08-17): ad renders were reproducing the Amazing Coffee pouch visibly
 * narrower than the physical product — the model was inferring a silhouette from a packshot instead
 * of being told the proportions. We already carry the answer: [[../../../docs/brain/tables/amazon_asins]]
 * maps ASIN → product, and SP-API's Catalog Items API publishes item/package dimensions.
 *
 * Two facts about the Amazon data this module is built around, both observed live on B0BKR169VT:
 *   1. Our mapped ASIN is often a `VARIATION_PARENT`, which carries NO dimensions — you have to walk
 *      `relationships` to the child ASINs and read theirs.
 *   2. Children disagree, and some are self-contradictory (B08KYMN52M reported ITEM dims LARGER
 *      than its own PACKAGE dims). So a selection rule is required; taking the first child is wrong.
 *
 * Mapping is PRODUCT-level (that is all `amazon_asins` carries), and variants of one product share a
 * pouch — only the flavour differs — so a resolved size applies to every variant of that product.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import { spApiRequest } from "@/lib/amazon/auth";

type Admin = ReturnType<typeof createAdminClient>;

/** One axis as Amazon reports it. */
interface AmazonMeasure {
  unit?: string;
  value?: number;
}

/** One `dimensions[]` entry from Catalog Items. `item` = the product; `package` = as shipped. */
export interface AmazonDimensionSet {
  height?: AmazonMeasure;
  length?: AmazonMeasure;
  width?: AmazonMeasure;
  weight?: AmazonMeasure;
}

/** Millimetre triple in the orientation the renderer wants: a pouch STANDING UP. */
export interface PackDimensionsMm {
  widthMm: number;
  heightMm: number;
  depthMm: number;
}

/** A candidate reading, tagged with where it came from (for the audit line). */
export interface PackDimensionCandidate extends PackDimensionsMm {
  asin: string;
  source: "item" | "package";
}

const MM_PER_INCH = 25.4;

/** Convert an Amazon measure to mm. Returns null for a missing/zero value or an unknown unit —
 *  never guesses a unit, because a wrong unit is a 25x error in the render prompt. */
export function measureToMm(m?: AmazonMeasure | null): number | null {
  const v = typeof m?.value === "number" ? m.value : null;
  if (!v || v <= 0) return null;
  const unit = String(m?.unit ?? "").toLowerCase();
  if (unit === "inches" || unit === "inch" || unit === "in") return v * MM_PER_INCH;
  if (unit === "millimeters" || unit === "millimetres" || unit === "mm") return v;
  if (unit === "centimeters" || unit === "centimetres" || unit === "cm") return v * 10;
  return null;
}

/**
 * Turn one Amazon dimension set into a standing-pouch triple.
 *
 * Amazon's axis NAMES are unreliable for a flat pouch (it is measured lying down, so its "height"
 * is really the gusset). Rather than trust the labels we sort the three axes: the LARGEST is the
 * pouch's height standing up, the MIDDLE is its width, the SMALLEST is its depth. That holds for
 * any stand-up pouch and is far more robust than believing `height` means height.
 */
export function toStandingPouchMm(set?: AmazonDimensionSet | null): PackDimensionsMm | null {
  if (!set) return null;
  const axes = [measureToMm(set.height), measureToMm(set.length), measureToMm(set.width)].filter(
    (n): n is number => n !== null,
  );
  if (axes.length < 3) return null;
  axes.sort((a, b) => b - a);
  return { heightMm: round(axes[0]), widthMm: round(axes[1]), depthMm: round(axes[2]) };
}

function round(n: number): number {
  return Math.round(n);
}

/**
 * Pick one reading from several candidate ASINs.
 *
 * Rule: prefer the CONSENSUS. Group candidates whose height AND width are within `tolerancePct` of
 * each other and take the largest group; inside it, take the median of each axis. A lone
 * disagreeing child (or a self-contradictory one) is outvoted rather than trusted. With only one
 * candidate we return it — one reading is better than none, and the caller records the provenance.
 *
 * Pure — no I/O, so the selection rule is unit-testable without SP-API.
 */
export function selectConsensusDimensions(
  candidates: PackDimensionCandidate[],
  tolerancePct = 0.1,
): { chosen: PackDimensionsMm; agreedWith: PackDimensionCandidate[] } | null {
  if (!candidates.length) return null;
  let best: PackDimensionCandidate[] = [];
  for (const anchor of candidates) {
    const group = candidates.filter(
      (c) =>
        within(c.heightMm, anchor.heightMm, tolerancePct) && within(c.widthMm, anchor.widthMm, tolerancePct),
    );
    if (group.length > best.length) best = group;
  }
  if (!best.length) return null;
  return {
    chosen: {
      widthMm: median(best.map((c) => c.widthMm)),
      heightMm: median(best.map((c) => c.heightMm)),
      depthMm: median(best.map((c) => c.depthMm)),
    },
    agreedWith: best,
  };
}

function within(a: number, b: number, pct: number): boolean {
  if (a <= 0 || b <= 0) return false;
  return Math.abs(a - b) / Math.max(a, b) <= pct;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/** A self-contradictory reading: the bare item measuring LARGER than the package it ships in.
 *  Observed on B08KYMN52M. Such a reading is dropped rather than averaged in. */
export function isSelfContradictory(item: PackDimensionsMm | null, pkg: PackDimensionsMm | null): boolean {
  if (!item || !pkg) return false;
  return item.heightMm > pkg.heightMm && item.widthMm > pkg.widthMm;
}

interface CatalogItemResponse {
  asin?: string;
  dimensions?: Array<{ item?: AmazonDimensionSet; package?: AmazonDimensionSet }>;
  summaries?: Array<{ itemClassification?: string; itemName?: string }>;
  relationships?: Array<{ relationships?: Array<{ childAsins?: string[] }> }>;
}

async function catalogItem(
  connectionId: string,
  marketplaceId: string,
  asin: string,
  includedData: string,
): Promise<CatalogItemResponse | null> {
  const res = await spApiRequest(
    connectionId,
    marketplaceId,
    "GET",
    `/catalog/2022-04-01/items/${asin}?marketplaceIds=${marketplaceId}&includedData=${includedData}`,
  );
  if (!res.ok) return null;
  try {
    return JSON.parse(await res.text()) as CatalogItemResponse;
  } catch {
    return null;
  }
}

export interface ResolveResult {
  productId: string;
  parentAsins: string[];
  candidates: PackDimensionCandidate[];
  chosen: PackDimensionsMm | null;
  reason: string;
}

/**
 * Resolve one product's pack size from every ASIN mapped to it, following VARIATION_PARENTs down to
 * their children. Read-only — the caller decides whether to persist.
 */
export async function resolvePackDimensionsForProduct(
  admin: Admin,
  workspaceId: string,
  productId: string,
): Promise<ResolveResult> {
  const out: ResolveResult = { productId, parentAsins: [], candidates: [], chosen: null, reason: "" };

  const { data: conn } = await admin
    .from("amazon_connections")
    .select("id, marketplace_id")
    .eq("workspace_id", workspaceId)
    .limit(1)
    .maybeSingle();
  const connection = conn as { id?: string; marketplace_id?: string } | null;
  if (!connection?.id) {
    out.reason = "no amazon_connections row for this workspace";
    return out;
  }
  const marketplaceId = connection.marketplace_id || "ATVPDKIKX0DER";

  const { data: asinRows } = await admin
    .from("amazon_asins")
    .select("asin")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);
  const mapped = ((asinRows ?? []) as Array<{ asin: string }>).map((r) => r.asin).filter(Boolean);
  out.parentAsins = mapped;
  if (!mapped.length) {
    out.reason = "no amazon_asins row maps to this product";
    return out;
  }

  // Expand each mapped ASIN to itself + its children (a VARIATION_PARENT carries no dimensions).
  const toRead = new Set<string>();
  for (const asin of mapped) {
    toRead.add(asin);
    const rel = await catalogItem(connection.id, marketplaceId, asin, "relationships");
    for (const r of rel?.relationships ?? []) {
      for (const inner of r.relationships ?? []) {
        for (const child of inner.childAsins ?? []) toRead.add(child);
      }
    }
  }

  for (const asin of toRead) {
    const doc = await catalogItem(connection.id, marketplaceId, asin, "dimensions,summaries");
    const dims = (doc?.dimensions ?? [])[0];
    if (!dims) continue;
    const item = toStandingPouchMm(dims.item);
    const pkg = toStandingPouchMm(dims.package);
    if (isSelfContradictory(item, pkg)) continue; // drop the contradictory reading entirely
    // Prefer the ITEM measurement (the product itself); fall back to the package.
    if (item) out.candidates.push({ ...item, asin, source: "item" });
    else if (pkg) out.candidates.push({ ...pkg, asin, source: "package" });
  }

  if (!out.candidates.length) {
    out.reason = `read ${toRead.size} ASIN(s), none published usable dimensions`;
    return out;
  }
  const consensus = selectConsensusDimensions(out.candidates);
  if (!consensus) {
    out.reason = "candidates present but no consensus could be formed";
    return out;
  }
  out.chosen = consensus.chosen;
  out.reason = `consensus of ${consensus.agreedWith.length}/${out.candidates.length} candidate(s): ${consensus.agreedWith
    .map((c) => `${c.asin}(${c.source})`)
    .join(", ")}`;
  return out;
}

/**
 * Persist a resolved size onto every variant of the product. By default it will NOT overwrite a
 * variant that already has a width recorded — a hand-measured value outranks a scraped one, and the
 * CEO set Amazing Coffee's by hand on 2026-08-17. Pass `overwrite` to force.
 */
export async function persistPackDimensions(
  admin: Admin,
  workspaceId: string,
  productId: string,
  dims: PackDimensionsMm,
  opts: { overwrite?: boolean } = {},
): Promise<{ updated: number; skipped: number }> {
  const { data: variants } = await admin
    .from("product_variants")
    .select("id, package_width_mm")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);
  const rows = (variants ?? []) as Array<{ id: string; package_width_mm: number | null }>;
  let updated = 0;
  let skipped = 0;
  for (const v of rows) {
    if (v.package_width_mm && !opts.overwrite) {
      skipped++;
      continue;
    }
    const { error } = await admin
      .from("product_variants")
      .update({
        package_width_mm: dims.widthMm,
        package_height_mm: dims.heightMm,
        package_depth_mm: dims.depthMm,
      })
      .eq("id", v.id);
    if (!error) updated++;
  }
  return { updated, skipped };
}
