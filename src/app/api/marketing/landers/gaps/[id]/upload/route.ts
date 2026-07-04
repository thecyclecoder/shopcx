import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getBlueprint,
  listContentGaps,
  resolveContentGap,
  setBlueprintStatus,
  writeCategorizedProductMedia,
  type LanderContentGap,
  type ProductMediaCategory,
} from "@/lib/lander-blueprints";

// Marketing → Lander uploads WRITE endpoint (content-upload-and-lander-build.md Phase 1).
// Founder resolves ONE gap by uploading a real-evidence asset. On success:
//   1. Store the file in the `product-media` bucket at products/<product_id>/lander-gap/<gap_id>-<stamp>.<ext>
//   2. Upsert a categorized product_media row via the lander-blueprints SDK — the asset becomes
//      PERMANENT product intelligence, keyed by product + category (asset_role) + source='uploaded'.
//   3. Resolve the gap (status='resolved', resolved_media_id).
//   4. If it was the LAST open gap on the blueprint → advance status to 'content_complete'.
//
// Owner-only. Mirrors the auth shape used by /api/research/landers.

const BUCKET = "product-media";

const ALLOWED_MIME = new Set<string>([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "video/mp4",
  "video/quicktime",
]);
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB — big enough for a phone-shot before/after, small enough to bound abuse

function extFromMime(mime: string): string {
  switch (mime) {
    case "image/jpeg": return "jpg";
    case "image/png": return "png";
    case "image/webp": return "webp";
    case "image/avif": return "avif";
    case "image/gif": return "gif";
    case "video/mp4": return "mp4";
    case "video/quicktime": return "mov";
    default: return "bin";
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: gapId } = await params;
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!workspaceId) return NextResponse.json({ error: "workspaceId required" }, { status: 400 });
  if (!gapId) return NextResponse.json({ error: "gap id required" }, { status: 400 });

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();
  if (!member || (member.role as string) !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fetch gap first — we need blueprint_id / asset_role / block_ref before touching storage.
  // Direct scoped SELECT: reads sit outside the SDK's insert|update|upsert chokepoint, and
  // this is an O(1) lookup by (workspace_id, id) — cheaper than paging the workspace's gaps.
  const { data: gapRow } = await admin
    .from("lander_content_gaps")
    .select("id, workspace_id, blueprint_id, asset_role, block_ref, description, status")
    .eq("workspace_id", workspaceId)
    .eq("id", gapId)
    .maybeSingle();
  const gap = gapRow as Pick<
    LanderContentGap,
    "id" | "workspace_id" | "blueprint_id" | "asset_role" | "block_ref" | "description" | "status"
  > | null;
  if (!gap) return NextResponse.json({ error: "gap not found" }, { status: 404 });
  if (gap.status !== "open") {
    return NextResponse.json({ error: "gap already resolved" }, { status: 409 });
  }

  const blueprint = await getBlueprint(workspaceId, gap.blueprint_id);
  if (!blueprint) return NextResponse.json({ error: "blueprint not found" }, { status: 404 });

  const formData = await req.formData().catch(() => null);
  if (!formData) return NextResponse.json({ error: "Invalid form data" }, { status: 400 });

  const file = formData.get("file");
  const caption = ((formData.get("caption") as string) || "").trim() || null;
  if (!(file instanceof File)) return NextResponse.json({ error: "Missing file" }, { status: 400 });

  const mime = file.type || "application/octet-stream";
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json({ error: `Unsupported media type '${mime}'` }, { status: 400 });
  }
  if (file.size <= 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: `File must be 1 byte – ${MAX_BYTES} bytes` }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const stamp = Date.now();
  const ext = extFromMime(mime);
  const storagePath = `products/${blueprint.product_id}/lander-gap/${gap.id}-${stamp}.${ext}`;

  const { error: upErr } = await admin.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: mime,
    upsert: true,
    cacheControl: "31536000",
  });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });
  const publicUrl = admin.storage.from(BUCKET).getPublicUrl(storagePath).data.publicUrl;

  // Slot is stable per-gap so re-uploading the same gap upserts the row (rather than
  // orphaning the earlier storage object). display_order=0 keeps us out of the way of
  // the hero gallery's numbered slots.
  const slot = `lander-gap-${gap.id}`;
  const media = await writeCategorizedProductMedia({
    workspace_id: workspaceId,
    product_id: blueprint.product_id,
    slot,
    url: publicUrl,
    storage_path: storagePath,
    category: gap.asset_role as ProductMediaCategory,
    source: "uploaded",
    caption,
    alt_text: gap.description,
    mime_type: mime,
    display_order: 0,
  });

  await resolveContentGap(workspaceId, gap.id, media.id);

  // If this was the blueprint's LAST open gap, the copy pass is complete —
  // advance status so Phase 2's deterministic verify + build-spec handoff can pick it up.
  const remainingOpen = await listContentGaps(workspaceId, {
    blueprint_id: gap.blueprint_id,
    status: "open",
  });
  let blueprintComplete = false;
  if (remainingOpen.length === 0) {
    await setBlueprintStatus(workspaceId, gap.blueprint_id, "content_complete");
    blueprintComplete = true;
  }

  return NextResponse.json({
    media: {
      id: media.id,
      url: media.url,
      slot: media.slot,
      category: media.category,
      caption: media.caption,
    },
    gap: { id: gap.id, status: "resolved", resolved_media_id: media.id },
    blueprint_complete: blueprintComplete,
  });
}
