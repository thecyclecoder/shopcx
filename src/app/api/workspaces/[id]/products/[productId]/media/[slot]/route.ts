import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { transcodeUpload } from "@/lib/image-transcode";

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
  const originalPath = `products/${productId}/${slot}/${baseName}.${transcoded.originalExt}`;
  const webpPath = transcoded.webpBuffer
    ? `products/${productId}/${slot}/${baseName}.webp`
    : null;
  const avifPath = transcoded.avifBuffer
    ? `products/${productId}/${slot}/${baseName}.avif`
    : null;

  const uploads: Array<Promise<{ error: { message: string } | null }>> = [
    admin.storage
      .from(BUCKET)
      .upload(originalPath, transcoded.originalBuffer, {
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
  const results = await Promise.all(uploads);
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }

  const urlFor = (p: string) => admin.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
  const publicUrl = urlFor(originalPath);
  const webpUrl = webpPath ? urlFor(webpPath) : null;
  const avifUrl = avifPath ? urlFor(avifPath) : null;

  // Remove prior files so storage doesn't accumulate orphans.
  const { data: existing } = await admin
    .from("product_media")
    .select("storage_path, webp_storage_path, avif_storage_path")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("slot", slot)
    .maybeSingle();

  const toRemove = [
    existing?.storage_path,
    existing?.webp_storage_path,
    existing?.avif_storage_path,
  ].filter((p): p is string => !!p && p !== originalPath && p !== webpPath && p !== avifPath);
  if (toRemove.length > 0) {
    await admin.storage.from(BUCKET).remove(toRemove).catch(() => {});
  }

  const { data: row, error } = await admin
    .from("product_media")
    .upsert(
      {
        workspace_id: workspaceId,
        product_id: productId,
        slot,
        url: publicUrl,
        storage_path: originalPath,
        webp_url: webpUrl,
        webp_storage_path: webpPath,
        avif_url: avifUrl,
        avif_storage_path: avifPath,
        alt_text: altText,
        width: transcoded.width,
        height: transcoded.height,
        file_size: transcoded.originalBuffer.byteLength,
        mime_type: transcoded.originalContentType,
        uploaded_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,product_id,slot" },
    )
    .select("*")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ media: row });
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
    .select("storage_path, webp_storage_path, avif_storage_path")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("slot", slot)
    .maybeSingle();

  const toRemove = [
    existing?.storage_path,
    existing?.webp_storage_path,
    existing?.avif_storage_path,
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
