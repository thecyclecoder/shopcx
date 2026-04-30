/**
 * Gallery management for a product slot. The hero slot supports
 * multiple images (display_order 0 = main, 1+ = additional gallery
 * thumbnails). This endpoint lets the dashboard:
 *   GET    — list all rows for this slot, ordered
 *   PATCH  — reorder (bulk update display_order from a passed array of ids)
 *   DELETE ?id=UUID — remove one specific gallery item by id
 *
 * Single-image upload still goes to the parent /media/{slot} route;
 * to add a gallery item, POST to /media/{slot} with display_order=N
 * in the form data.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";

const BUCKET = "product-media";

async function authorize(req: NextRequest, workspaceId: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false as const, status: 401, error: "Unauthorized" };
  const admin = createAdminClient();
  const { data: member } = await admin.from("workspace_members")
    .select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).single();
  if (!member || !["owner", "admin"].includes(member.role)) {
    return { ok: false as const, status: 403, error: "Forbidden" };
  }
  return { ok: true as const, admin, userId: user.id };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; productId: string; slot: string }> },
) {
  const { id: workspaceId, productId, slot } = await params;
  const auth = await authorize(req, workspaceId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: items } = await auth.admin
    .from("product_media")
    .select("id, slot, display_order, url, webp_url, avif_url, avif_480_url, webp_480_url, avif_750_url, webp_750_url, avif_1080_url, webp_1080_url, avif_1500_url, webp_1500_url, avif_1920_url, webp_1920_url, alt_text, width, height")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("slot", slot)
    .order("display_order");

  return NextResponse.json({ items: items || [] });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; productId: string; slot: string }> },
) {
  const { id: workspaceId, productId, slot } = await params;
  const auth = await authorize(req, workspaceId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await req.json().catch(() => ({}));
  const orderedIds = Array.isArray(body.ordered_ids) ? (body.ordered_ids as string[]) : null;
  if (!orderedIds) return NextResponse.json({ error: "ordered_ids[] required" }, { status: 400 });

  // Two-pass reorder to dodge the unique (slot, display_order) constraint:
  // first move every row to a high temporary order, then assign final
  // positions starting at 0.
  for (let i = 0; i < orderedIds.length; i++) {
    await auth.admin.from("product_media").update({
      display_order: 1000 + i,
      updated_at: new Date().toISOString(),
    }).eq("id", orderedIds[i]).eq("workspace_id", workspaceId).eq("product_id", productId).eq("slot", slot);
  }
  for (let i = 0; i < orderedIds.length; i++) {
    await auth.admin.from("product_media").update({
      display_order: i,
      updated_at: new Date().toISOString(),
    }).eq("id", orderedIds[i]).eq("workspace_id", workspaceId).eq("product_id", productId).eq("slot", slot);
  }

  // Revalidate storefront so reorder shows immediately
  try {
    const { data: product } = await auth.admin.from("products").select("handle").eq("id", productId).single();
    const { data: ws } = await auth.admin.from("workspaces").select("storefront_slug").eq("id", workspaceId).single();
    if (product?.handle && ws?.storefront_slug) revalidatePath(`/store/${ws.storefront_slug}/${product.handle}`);
  } catch { /* non-fatal */ }

  return NextResponse.json({ success: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; productId: string; slot: string }> },
) {
  const { id: workspaceId, productId, slot } = await params;
  const auth = await authorize(req, workspaceId);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const itemId = new URL(req.url).searchParams.get("id");
  if (!itemId) return NextResponse.json({ error: "id query param required" }, { status: 400 });

  // Fetch the row first so we can clean up storage paths
  const { data: row } = await auth.admin
    .from("product_media")
    .select("storage_path, webp_storage_path, avif_storage_path, avif_480_storage_path, webp_480_storage_path, avif_750_storage_path, webp_750_storage_path, avif_1080_storage_path, webp_1080_storage_path, avif_1500_storage_path, webp_1500_storage_path, avif_1920_storage_path, webp_1920_storage_path, display_order")
    .eq("id", itemId).eq("workspace_id", workspaceId).eq("product_id", productId).eq("slot", slot)
    .maybeSingle();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const r = row as Record<string, string | null | number>;
  const paths = [
    r.storage_path, r.webp_storage_path, r.avif_storage_path,
    r.avif_480_storage_path, r.webp_480_storage_path,
    r.avif_750_storage_path, r.webp_750_storage_path,
    r.avif_1080_storage_path, r.webp_1080_storage_path,
    r.avif_1500_storage_path, r.webp_1500_storage_path,
    r.avif_1920_storage_path, r.webp_1920_storage_path,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  if (paths.length) await auth.admin.storage.from(BUCKET).remove(paths).catch(() => {});

  await auth.admin.from("product_media").delete().eq("id", itemId);

  // Compact display_order for remaining rows (so deletes don't leave gaps)
  const { data: remaining } = await auth.admin.from("product_media")
    .select("id").eq("workspace_id", workspaceId).eq("product_id", productId).eq("slot", slot)
    .order("display_order");
  if (remaining?.length) {
    for (let i = 0; i < remaining.length; i++) {
      await auth.admin.from("product_media").update({
        display_order: 1000 + i, updated_at: new Date().toISOString(),
      }).eq("id", remaining[i].id);
    }
    for (let i = 0; i < remaining.length; i++) {
      await auth.admin.from("product_media").update({
        display_order: i, updated_at: new Date().toISOString(),
      }).eq("id", remaining[i].id);
    }
  }

  try {
    const { data: product } = await auth.admin.from("products").select("handle").eq("id", productId).single();
    const { data: ws } = await auth.admin.from("workspaces").select("storefront_slug").eq("id", workspaceId).single();
    if (product?.handle && ws?.storefront_slug) revalidatePath(`/store/${ws.storefront_slug}/${product.handle}`);
  } catch { /* non-fatal */ }

  return NextResponse.json({ success: true });
}
