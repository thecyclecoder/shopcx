import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { revalidatePath } from "next/cache";

const ALLOWED_FONT_KEYS = new Set([
  "montserrat",
  "inter",
  "poppins",
  "lato",
  "open-sans",
  "work-sans",
  "nunito-sans",
  "playfair",
]);

function isHex(s: string): boolean {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(s);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: workspaceId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("workspaces")
    .select(
      "storefront_font, storefront_primary_color, storefront_accent_color, storefront_logo_url, storefront_favicon_url, storefront_slug, storefront_off_platform_review_count",
    )
    .eq("id", workspaceId)
    .single();

  return NextResponse.json({
    font_key: data?.storefront_font || null,
    primary_color: data?.storefront_primary_color || null,
    accent_color: data?.storefront_accent_color || null,
    logo_url: data?.storefront_logo_url || null,
    favicon_url: data?.storefront_favicon_url || null,
    storefront_slug: data?.storefront_slug || null,
    off_platform_review_count: data?.storefront_off_platform_review_count ?? 0,
  });
}

export async function PATCH(
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

  const body = await request.json().catch(() => ({}));
  const update: Record<string, string | number | null> = {};

  if ("font_key" in body) {
    if (body.font_key === null || body.font_key === "") {
      update.storefront_font = null;
    } else if (typeof body.font_key === "string" && ALLOWED_FONT_KEYS.has(body.font_key)) {
      update.storefront_font = body.font_key;
    } else {
      return NextResponse.json({ error: "Unknown font_key" }, { status: 400 });
    }
  }

  for (const [inKey, outKey] of [
    ["primary_color", "storefront_primary_color"],
    ["accent_color", "storefront_accent_color"],
  ] as const) {
    if (inKey in body) {
      if (body[inKey] === null || body[inKey] === "") {
        update[outKey] = null;
      } else if (typeof body[inKey] === "string" && isHex(body[inKey])) {
        update[outKey] = body[inKey];
      } else {
        return NextResponse.json(
          { error: `Invalid ${inKey} — must be hex like #18181b` },
          { status: 400 },
        );
      }
    }
  }

  if ("logo_url" in body) {
    update.storefront_logo_url =
      typeof body.logo_url === "string" && body.logo_url.trim() ? body.logo_url.trim() : null;
  }

  if ("favicon_url" in body) {
    update.storefront_favicon_url =
      typeof body.favicon_url === "string" && body.favicon_url.trim() ? body.favicon_url.trim() : null;
  }

  if ("off_platform_review_count" in body) {
    const n = Number(body.off_platform_review_count);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return NextResponse.json({ error: "off_platform_review_count must be a non-negative integer" }, { status: 400 });
    }
    update.storefront_off_platform_review_count = n;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { error } = await admin
    .from("workspaces")
    .update(update)
    .eq("id", workspaceId);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Invalidate storefront ISR caches — design changes should show up
  // immediately, not after the 1h TTL.
  try {
    const { data: ws } = await admin
      .from("workspaces")
      .select("storefront_slug")
      .eq("id", workspaceId)
      .single();
    if (ws?.storefront_slug) {
      const { data: products } = await admin
        .from("products")
        .select("handle")
        .eq("workspace_id", workspaceId)
        .eq("intelligence_status", "published");
      for (const p of products || []) {
        if (!p.handle) continue;
        revalidatePath(`/${p.handle}`);
        revalidatePath(`/store/${ws.storefront_slug}/${p.handle}`);
      }
    }
  } catch {
    // Non-fatal — ISR will eventually pick it up.
  }

  return NextResponse.json({ success: true });
}
