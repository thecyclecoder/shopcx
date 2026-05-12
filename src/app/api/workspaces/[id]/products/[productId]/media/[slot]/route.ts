import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { transcodeUpload } from "@/lib/image-transcode";
import { revalidatePath } from "next/cache";

const BUCKET = "product-media";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string; slot: string }> },
) {
  const { id: workspaceId, productId, slot } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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

  const formData = await request.formData().catch(() => null);
  if (!formData) return NextResponse.json({ error: "Invalid form data" }, { status: 400 });

  const file = formData.get("file");
  const altText = (formData.get("alt_text") as string) || "";
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const sourceBuffer = Buffer.from(arrayBuffer);

  // Transcode: produces a normalized original plus WebP/AVIF variants
  // where possible. SVG/GIF pass through unmodified.
  let transcoded;
  try {
    transcoded = await transcodeUpload(sourceBuffer, file.type || "application/octet-stream");
  } catch {
    return NextResponse.json(
      { error: "Image could not be processed. Try a standard JPG, PNG, WebP, or AVIF." },
      { status: 400 },
    );
  }

  const stamp = Date.now();
  const baseName = `${slot}-${stamp}`;
  const baseDir = `products/${productId}/${slot}`;

  const originalPath = `${baseDir}/${baseName}.${transcoded.originalExt}`;
  const webpPath = transcoded.webpBuffer ? `${baseDir}/${baseName}.webp` : null;
  const avifPath = transcoded.avifBuffer ? `${baseDir}/${baseName}.avif` : null;

  // Variant paths: { 640: { avif, webp }, 1200: {...}, 1920: {...} }
  const variantPaths: Record<number, { avif: string | null; webp: string | null }> = {};
  for (const v of transcoded.variants) {
    variantPaths[v.width] = {
      avif: v.avifBuffer ? `${baseDir}/${baseName}-${v.width}.avif` : null,
      webp: v.webpBuffer ? `${baseDir}/${baseName}-${v.width}.webp` : null,
    };
  }

  // Push every file up in parallel. cacheControl is set on the object
  // but also gets overridden by the edge image proxy (see
  // /storefront-img/[...path]) which is what actually serves the hero
  // bytes to end users.
  const uploads: Array<Promise<{ error: { message: string } | null }>> = [
    admin.storage.from(BUCKET).upload(originalPath, transcoded.originalBuffer, {
      contentType: transcoded.originalContentType,
      upsert: true,
      cacheControl: "31536000",
    }),
  ];
  if (webpPath && transcoded.webpBuffer) {
    uploads.push(
      admin.storage.from(BUCKET).upload(webpPath, transcoded.webpBuffer, {
        contentType: "image/webp",
        upsert: true,
        cacheControl: "31536000",
      }),
    );
  }
  if (avifPath && transcoded.avifBuffer) {
    uploads.push(
      admin.storage.from(BUCKET).upload(avifPath, transcoded.avifBuffer, {
        contentType: "image/avif",
        upsert: true,
        cacheControl: "31536000",
      }),
    );
  }
  for (const v of transcoded.variants) {
    const paths = variantPaths[v.width];
    if (paths.avif && v.avifBuffer) {
      uploads.push(
        admin.storage.from(BUCKET).upload(paths.avif, v.avifBuffer, {
          contentType: "image/avif",
          upsert: true,
          cacheControl: "31536000",
        }),
      );
    }
    if (paths.webp && v.webpBuffer) {
      uploads.push(
        admin.storage.from(BUCKET).upload(paths.webp, v.webpBuffer, {
          contentType: "image/webp",
          upsert: true,
          cacheControl: "31536000",
        }),
      );
    }
  }

  const results = await Promise.all(uploads);
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }

  const urlFor = (p: string) => admin.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
  const publicUrl = urlFor(originalPath);
  const webpUrl = webpPath ? urlFor(webpPath) : null;
  const avifUrl = avifPath ? urlFor(avifPath) : null;

  // display_order is set further down; pre-compute it here so we can
  // scope the "remove prior files" query to THIS specific display_order
  // slot. Without the display_order filter, gallery uploads (where the
  // same slot has multiple rows at different display_orders) clobber
  // sibling rows' storage:
  //   - Upload image #2 at display_order=1
  //   - maybeSingle() returns display_order=0's row (since that's the
  //     only existing row at that point)
  //   - cleanup deletes all of display_order=0's files because they
  //     aren't in image #2's new paths
  //   - display_order=0's DB row stays intact, pointing at gone files
  // Surfaced on the Amazing Coffee hero gallery: main image renders
  // from CDN cache while the actual storage objects are gone.
  const requestedOrderForCleanup = parseInt((formData.get("display_order") as string) || "0", 10);
  const displayOrderForCleanup = Number.isFinite(requestedOrderForCleanup) && requestedOrderForCleanup >= 0
    ? requestedOrderForCleanup
    : 0;

  // Remove prior files so storage doesn't accumulate orphans.
  const { data: existing } = await admin
    .from("product_media")
    .select(
      "storage_path, webp_storage_path, avif_storage_path, avif_480_storage_path, webp_480_storage_path, avif_750_storage_path, webp_750_storage_path, avif_1080_storage_path, webp_1080_storage_path, avif_1500_storage_path, webp_1500_storage_path, avif_1920_storage_path, webp_1920_storage_path",
    )
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("slot", slot)
    .eq("display_order", displayOrderForCleanup)
    .maybeSingle();

  const newPaths = new Set(
    [
      originalPath,
      webpPath,
      avifPath,
      ...Object.values(variantPaths).flatMap((p) => [p.avif, p.webp]),
    ].filter((p): p is string => !!p),
  );
  const ex = existing as Record<string, string | null> | null;
  const toRemove = [
    ex?.storage_path,
    ex?.webp_storage_path,
    ex?.avif_storage_path,
    ex?.avif_480_storage_path,
    ex?.webp_480_storage_path,
    ex?.avif_750_storage_path,
    ex?.webp_750_storage_path,
    ex?.avif_1080_storage_path,
    ex?.webp_1080_storage_path,
    ex?.avif_1500_storage_path,
    ex?.webp_1500_storage_path,
    ex?.avif_1920_storage_path,
    ex?.webp_1920_storage_path,
  ].filter((p): p is string => !!p && !newPaths.has(p));
  if (toRemove.length > 0) {
    await admin.storage.from(BUCKET).remove(toRemove).catch(() => {});
  }

  const variantColumns: Record<string, string | null> = {};
  for (const w of [480, 750, 1080, 1500, 1920] as const) {
    const paths = variantPaths[w] || { avif: null, webp: null };
    variantColumns[`avif_${w}_url`] = paths.avif ? urlFor(paths.avif) : null;
    variantColumns[`webp_${w}_url`] = paths.webp ? urlFor(paths.webp) : null;
    variantColumns[`avif_${w}_storage_path`] = paths.avif;
    variantColumns[`webp_${w}_storage_path`] = paths.webp;
  }

  // display_order: 0 = main image; 1+ = additional gallery slots.
  // Already parsed above for the cleanup query — reuse.
  const displayOrder = displayOrderForCleanup;

  const { data: row, error } = await admin
    .from("product_media")
    .upsert(
      {
        workspace_id: workspaceId,
        product_id: productId,
        slot,
        display_order: displayOrder,
        url: publicUrl,
        storage_path: originalPath,
        webp_url: webpUrl,
        webp_storage_path: webpPath,
        avif_url: avifUrl,
        avif_storage_path: avifPath,
        ...variantColumns,
        alt_text: altText,
        width: transcoded.width,
        height: transcoded.height,
        file_size: transcoded.originalBuffer.byteLength,
        mime_type: transcoded.originalContentType,
        uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,product_id,slot,display_order" },
    )
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Revalidate storefront pages so the new image appears immediately.
  // Cascade to every product in any link group this product belongs to —
  // a hero upload on K-Cups affects the toggle preview on Amazing Coffee,
  // and vice versa. Without this, uploading a hero on one linked product
  // updated only its own page; the sibling page rendering the toggle
  // kept serving the stale (or null) image until its own next rebuild.
  try {
    const { data: ws } = await admin.from("workspaces").select("storefront_slug").eq("id", workspaceId).single();
    const slug = ws?.storefront_slug || null;
    await revalidateProductAndLinkedSiblings(admin, workspaceId, productId, slug);
  } catch { /* non-fatal */ }

  return NextResponse.json({ media: row });
}

/**
 * Revalidate the storefront PDPs for a product and every product it
 * shares a link group with. Public path (/{handle}) and admin preview
 * path (/store/{ws_slug}/{handle}).
 */
async function revalidateProductAndLinkedSiblings(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  productId: string,
  workspaceSlug: string | null,
): Promise<void> {
  // Find all product IDs that share a link group with this product.
  const ids = new Set<string>([productId]);
  const { data: groups } = await admin
    .from("product_link_members")
    .select("group_id")
    .eq("product_id", productId);
  const groupIds = (groups || []).map(g => g.group_id);
  if (groupIds.length) {
    const { data: siblings } = await admin
      .from("product_link_members")
      .select("product_id")
      .in("group_id", groupIds);
    for (const s of siblings || []) ids.add(s.product_id as string);
  }
  // Pull handles + scope to this workspace
  const { data: products } = await admin
    .from("products")
    .select("handle")
    .in("id", Array.from(ids))
    .eq("workspace_id", workspaceId);
  for (const p of products || []) {
    if (!p.handle) continue;
    if (workspaceSlug) revalidatePath(`/store/${workspaceSlug}/${p.handle}`);
    revalidatePath(`/${p.handle}`);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string; slot: string }> },
) {
  const { id: workspaceId, productId, slot } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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

  const body = await request.json().catch(() => ({}));
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.alt_text === "string") update.alt_text = body.alt_text;

  const { error } = await admin
    .from("product_media")
    .update(update)
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("slot", slot);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; productId: string; slot: string }> },
) {
  const { id: workspaceId, productId, slot } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
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

  const { data: existing } = await admin
    .from("product_media")
    .select(
      "storage_path, webp_storage_path, avif_storage_path, avif_480_storage_path, webp_480_storage_path, avif_750_storage_path, webp_750_storage_path, avif_1080_storage_path, webp_1080_storage_path, avif_1500_storage_path, webp_1500_storage_path, avif_1920_storage_path, webp_1920_storage_path",
    )
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("slot", slot)
    .maybeSingle();

  const e = existing as Record<string, string | null> | null;
  const toRemove = [
    e?.storage_path,
    e?.webp_storage_path,
    e?.avif_storage_path,
    e?.avif_480_storage_path,
    e?.webp_480_storage_path,
    e?.avif_750_storage_path,
    e?.webp_750_storage_path,
    e?.avif_1080_storage_path,
    e?.webp_1080_storage_path,
    e?.avif_1500_storage_path,
    e?.webp_1500_storage_path,
    e?.avif_1920_storage_path,
    e?.webp_1920_storage_path,
  ].filter((p): p is string => !!p);
  if (toRemove.length > 0) {
    await admin.storage.from(BUCKET).remove(toRemove).catch(() => {});
  }

  // Preserve the row for auto-created ingredient slots but blank the file
  await admin
    .from("product_media")
    .update({
      url: null,
      storage_path: null,
      webp_url: null,
      webp_storage_path: null,
      avif_url: null,
      avif_storage_path: null,
      avif_480_url: null,
      webp_480_url: null,
      avif_480_storage_path: null,
      webp_480_storage_path: null,
      avif_750_url: null,
      webp_750_url: null,
      avif_750_storage_path: null,
      webp_750_storage_path: null,
      avif_1080_url: null,
      webp_1080_url: null,
      avif_1080_storage_path: null,
      webp_1080_storage_path: null,
      avif_1500_url: null,
      webp_1500_url: null,
      avif_1500_storage_path: null,
      webp_1500_storage_path: null,
      avif_1920_url: null,
      webp_1920_url: null,
      avif_1920_storage_path: null,
      webp_1920_storage_path: null,
      file_size: null,
      mime_type: null,
      uploaded_at: null,
      alt_text: "",
      updated_at: new Date().toISOString(),
    })
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("slot", slot);

  return NextResponse.json({ success: true });
}
