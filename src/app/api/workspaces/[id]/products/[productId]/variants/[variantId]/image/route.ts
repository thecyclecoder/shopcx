import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";

const BUCKET = "product-media";

/**
 * Upload (POST) or remove (DELETE) the per-variant image. The image
 * is the transparent PNG used by the storefront price table to stack
 * the variant N times for each tier — admin uploads a single isolated
 * packaging shot per variant and the storefront generates the
 * 1-pack / 2-pack / 3-pack visuals from it.
 *
 * Keeps the pipeline simple: single original upload, no transcoding.
 * Variant images are tiny (200px on screen) so AVIF/WebP variants
 * aren't worth the extra CPU and round-trips.
 */
export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ id: string; productId: string; variantId: string }>;
  },
) {
  const { id: workspaceId, productId, variantId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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

  // Confirm the variant belongs to this product + workspace before
  // touching storage. Cheap RLS-style guard.
  const { data: variant } = await admin
    .from("product_variants")
    .select("id, image_url")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("id", variantId)
    .maybeSingle();
  if (!variant) {
    return NextResponse.json({ error: "Variant not found" }, { status: 404 });
  }

  const formData = await request.formData().catch(() => null);
  if (!formData)
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = (file.type || "").split("/")[1] || "png";
  const stamp = Date.now();
  const objectPath = `products/${productId}/variants/${variantId}-${stamp}.${ext}`;

  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(objectPath, buffer, {
      contentType: file.type || "image/png",
      upsert: true,
      cacheControl: "31536000",
    });
  if (upErr) {
    return NextResponse.json({ error: upErr.message }, { status: 500 });
  }

  // Public URL — variant images route through the edge proxy via
  // cdnUrl() at render time, so Vercel's CDN caches them. The raw
  // URL stored here is the Supabase public URL.
  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(objectPath);
  const publicUrl = pub.publicUrl;

  const { error: updateErr } = await admin
    .from("product_variants")
    .update({ image_url: publicUrl })
    .eq("id", variantId)
    .eq("workspace_id", workspaceId);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  // Revalidate the storefront so the new image lands on the next
  // price-table render. Best-effort: failures don't block the upload.
  try {
    const { data: product } = await admin
      .from("products")
      .select("handle")
      .eq("id", productId)
      .single();
    const { data: ws } = await admin
      .from("workspaces")
      .select("storefront_slug")
      .eq("id", workspaceId)
      .single();
    if (product?.handle && ws?.storefront_slug) {
      revalidatePath(`/store/${ws.storefront_slug}/${product.handle}`);
    }
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ image_url: publicUrl });
}

export async function DELETE(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ id: string; productId: string; variantId: string }>;
  },
) {
  const { id: workspaceId, productId, variantId } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
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

  const { error } = await admin
    .from("product_variants")
    .update({ image_url: null })
    .eq("id", variantId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
