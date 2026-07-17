import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { uploadBuffer, signedUrl } from "@/lib/ad-storage";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_BYTES = 10 * 1024 * 1024;

export async function POST(req: Request) {
  const { user } = await getAuthedUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const form = await req.formData();
  const workspaceId = form.get("workspaceId");
  const file = form.get("file");

  if (typeof workspaceId !== "string" || !workspaceId)
    return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  if (!(file instanceof File))
    return NextResponse.json({ error: "file required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || !["owner", "admin"].includes(member.role as string))
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const contentType = file.type;
  if (!ALLOWED.has(contentType))
    return NextResponse.json({ error: "unsupported_type" }, { status: 400 });
  if (file.size > MAX_BYTES)
    return NextResponse.json({ error: "file_too_large" }, { status: 400 });

  const buffer = Buffer.from(await file.arrayBuffer());
  const ext = contentType === "image/jpeg" ? "jpg" : contentType === "image/webp" ? "webp" : "png";
  const path = `avatars/${workspaceId}/${crypto.randomUUID()}.${ext}`;

  try {
    await uploadBuffer(path, buffer, contentType);
    const url = await signedUrl(path);
    return NextResponse.json({ url });
  } catch (e) {
    const message = e instanceof Error ? e.message : "upload_failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
