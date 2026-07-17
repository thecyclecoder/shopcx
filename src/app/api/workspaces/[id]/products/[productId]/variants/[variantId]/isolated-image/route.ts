import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = "product-media";
const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const ALLOWED = ["image/png", "image/jpeg", "image/webp", "image/avif"];

/**
 * Upload (POST) or remove (DELETE) the per-variant *isolated* image —
 * a background-free packaging shot used by the ad-tool to composite the
 * pack onto generated creative. Distinct from product_variants.image_url
 * (the storefront price-table image); this one feeds ad mockups only.
 *
 * Stored in the same product-media bucket as the storefront variant
 * image, at a stable per-variant path so re-uploads overwrite.
 */
/**
 * GET: read the variant's ad-tool fields (isolated image + physical
 * dimensions override). The storefront variants list API selects an
 * explicit column set that excludes these, so the dashboard loads them
 * from here on demand.
 */
export async function GET(
  _request: Request,
  {
    params,
  }: {
    params: Promise<{ id: string; productId: string; variantId: string }>;
  },
) {
  const { id: workspaceId, productId, variantId } = await params;

  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: variant } = await admin
    .from("product_variants")
    .select("isolated_image_url, physical_dimensions")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("id", variantId)
    .maybeSingle();
  if (!variant) {
    return NextResponse.json({ error: "Variant not found" }, { status: 404 });
  }

  return NextResponse.json({
    isolated_image_url: variant.isolated_image_url ?? null,
    physical_dimensions: variant.physical_dimensions ?? null,
  });
}

export async function POST(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ id: string; productId: string; variantId: string }>;
  },
) {
  const { id: workspaceId, productId, variantId } = await params;

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

  // Confirm the variant belongs to this product + workspace before
  // touching storage.
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

  const formData = await request.formData().catch(() => null);
  if (!formData)
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }
  if (!ALLOWED.includes(file.type)) {
    return NextResponse.json(
      { error: "Unsupported type — use PNG, JPEG, WebP, or AVIF" },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File too large (max 10MB)" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = (file.type || "").split("/")[1] || "png";
  const objectPath = `products/${workspaceId}/${productId}/variants/${variantId}/isolated.${ext}`;

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

  const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(objectPath);
  const publicUrl = pub.publicUrl;

  const { error: updateErr } = await admin
    .from("product_variants")
    .update({
      isolated_image_url: publicUrl,
      isolated_image_uploaded_at: new Date().toISOString(),
      isolated_image_uploaded_by: user.id,
    })
    .eq("id", variantId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);
  if (updateErr) {
    return NextResponse.json({ error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({ isolated_image_url: publicUrl });
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

  const { error } = await admin
    .from("product_variants")
    .update({
      isolated_image_url: null,
      isolated_image_uploaded_at: null,
      isolated_image_uploaded_by: null,
    })
    .eq("id", variantId)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
