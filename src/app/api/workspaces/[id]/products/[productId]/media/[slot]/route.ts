import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

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

  const ext = file.name.split(".").pop()?.toLowerCase() || "bin";
  const fileName = `${slot}-${Date.now()}.${ext}`;
  const storagePath = `products/${productId}/${slot}/${fileName}`;

  const arrayBuffer = await file.arrayBuffer();

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(storagePath, new Uint8Array(arrayBuffer), {
      contentType: file.type || "application/octet-stream",
      upsert: true,
    });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data: publicUrl } = admin.storage.from(BUCKET).getPublicUrl(storagePath);

  // Delete any existing row for this slot so we can replace storage cleanly
  const { data: existing } = await admin
    .from("product_media")
    .select("storage_path")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("slot", slot)
    .maybeSingle();

  if (existing?.storage_path && existing.storage_path !== storagePath) {
    await admin.storage.from(BUCKET).remove([existing.storage_path]).catch(() => {});
  }

  const { data: row, error } = await admin
    .from("product_media")
    .upsert(
      {
        workspace_id: workspaceId,
        product_id: productId,
        slot,
        url: publicUrl.publicUrl,
        storage_path: storagePath,
        alt_text: altText,
        file_size: file.size,
        mime_type: file.type || null,
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
    .select("storage_path")
    .eq("workspace_id", workspaceId)
    .eq("product_id", productId)
    .eq("slot", slot)
    .maybeSingle();

  if (existing?.storage_path) {
    await admin.storage.from(BUCKET).remove([existing.storage_path]).catch(() => {});
  }

  // Preserve the row for auto-created ingredient slots but blank the file
  await admin
    .from("product_media")
    .update({
      url: null,
      storage_path: null,
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
