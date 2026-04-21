import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { transcodeUpload } from "@/lib/image-transcode";

const BUCKET = "product-media";

/**
 * Workspace-scoped logo upload. Same Sharp pipeline as product media —
 * original + WebP + AVIF. Returns the WebP URL as the primary reference
 * since logos are usually graphics (better compression than JPEG).
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

  let transcoded;
  try {
    transcoded = await transcodeUpload(buffer, file.type || "application/octet-stream");
  } catch {
    return NextResponse.json({ error: "Could not process image" }, { status: 400 });
  }

  const stamp = Date.now();
  const basePath = `workspaces/${workspaceId}/logo/${stamp}`;
  const originalPath = `${basePath}.${transcoded.originalExt}`;
  const webpPath = transcoded.webpBuffer ? `${basePath}.webp` : null;
  const avifPath = transcoded.avifBuffer ? `${basePath}.avif` : null;

  const uploads = [
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
  const results = await Promise.all(uploads);
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    return NextResponse.json({ error: failed.error.message }, { status: 500 });
  }

  const urlFor = (p: string) => admin.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
  // Prefer WebP for logos (graphics compress much better as WebP than JPEG);
  // fall back to the original if the transcoder skipped it (SVG/GIF).
  const url = webpPath ? urlFor(webpPath) : urlFor(originalPath);

  return NextResponse.json({ url });
}
