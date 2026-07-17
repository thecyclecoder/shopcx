import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * PATCH: write physical_dimensions jsonb to either a product or one of
 * its variants. Body:
 *   { length_in, width_in, height_in, weight_oz?, shape, variantId? }
 *
 * When variantId is present we write product_variants.physical_dimensions
 * (after verifying the variant belongs to this product/workspace) so the
 * variant can override the product-level dimensions. Otherwise we write
 * products.physical_dimensions.
 *
 * These dimensions power the ad-tool's physical mockups — they describe
 * the real-world size + shape of the packaging behind each isolated
 * image, so generated creative renders the pack at a believable scale.
 */
const SHAPES = ["bag", "box", "bottle", "jar", "pouch", "other"] as const;
type Shape = (typeof SHAPES)[number];

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v) : (v as number);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const { id: workspaceId, productId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as {
    length_in?: unknown;
    width_in?: unknown;
    height_in?: unknown;
    weight_oz?: unknown;
    shape?: unknown;
    variantId?: unknown;
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const length_in = num(body.length_in);
  const width_in = num(body.width_in);
  const height_in = num(body.height_in);
  const weight_oz = num(body.weight_oz);
  const shape: Shape = SHAPES.includes(body.shape as Shape)
    ? (body.shape as Shape)
    : "other";

  if (length_in === null || width_in === null || height_in === null) {
    return NextResponse.json(
      { error: "length_in, width_in, and height_in are required positive numbers" },
      { status: 400 },
    );
  }

  const dimensions: {
    length_in: number;
    width_in: number;
    height_in: number;
    weight_oz?: number;
    shape: Shape;
  } = { length_in, width_in, height_in, shape };
  if (weight_oz !== null) dimensions.weight_oz = weight_oz;

  const variantId =
    typeof body.variantId === "string" && body.variantId ? body.variantId : null;

  if (variantId) {
    // Verify the variant belongs to this product + workspace.
    const { data: variant } = await admin
      .from("product_variants")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId)
      .eq("id", variantId)
      .maybeSingle();
    if (!variant) {
      return NextResponse.json({ error: "Variant not found" }, { status: 404 });
    }

    const { error } = await admin
      .from("product_variants")
      .update({ physical_dimensions: dimensions })
      .eq("id", variantId)
      .eq("workspace_id", workspaceId)
      .eq("product_id", productId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ physical_dimensions: dimensions, scope: "variant" });
  }

  const { error } = await admin
    .from("products")
    .update({ physical_dimensions: dimensions })
    .eq("id", productId)
    .eq("workspace_id", workspaceId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ physical_dimensions: dimensions, scope: "product" });
}
