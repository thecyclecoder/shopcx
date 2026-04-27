import { NextResponse } from "next/server";
import sharp from "sharp";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = "product-media";

/**
 * Workspace favicon upload. Square-cropped, downsized to 256×256, saved
 * as PNG (transparency-friendly + universally accepted as a favicon).
 * Browsers will downscale to 32×32 / 16×16 themselves.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;

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
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing file" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let pngBuffer: Buffer;
  try {
    pngBuffer = await sharp(buffer)
      .rotate()
      .resize(256, 256, { fit: "cover", position: "center" })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch {
    return NextResponse.json({ error: "Could not process image" }, { status: 400 });
  }

  const stamp = Date.now();
  const path = `workspaces/${workspaceId}/favicon/${stamp}.png`;

  const { error } = await admin.storage.from(BUCKET).upload(path, pngBuffer, {
    contentType: "image/png",
    upsert: true,
    cacheControl: "31536000",
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const url = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  return NextResponse.json({ url });
}
