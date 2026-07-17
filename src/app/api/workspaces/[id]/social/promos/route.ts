import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

async function requireUser() {
  const { user } = await getAuthedUser();
  return user;
}

// Create a promo (the way an operator declares a holiday/seasonal campaign).
// If it names an emphasis product, kick off AI promo-graphic generation.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  if (!(await requireUser())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json();
  if (!b.name || !b.starts_on || !b.ends_on || !b.brief) return NextResponse.json({ error: "name, starts_on, ends_on, brief required" }, { status: 400 });
  const admin = createAdminClient();
  const emphasis = b.emphasis_product_id || null;
  const { data, error } = await admin.from("social_campaigns").insert({
    workspace_id: workspaceId,
    name: b.name, starts_on: b.starts_on, ends_on: b.ends_on, brief: b.brief,
    emphasis_product_id: emphasis,
    boost_per_platform_per_day: b.boost_per_platform_per_day || null,
    active: b.active !== false,
    graphics_status: emphasis ? "generating" : "none",
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (emphasis) await inngest.send({ name: "social/promo.graphics", data: { workspace_id: workspaceId, campaign_id: data.id } });
  return NextResponse.json({ promo: data });
}

// Toggle active / delete a promo.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  if (!(await requireUser())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json();
  if (!b.promo_id) return NextResponse.json({ error: "promo_id required" }, { status: 400 });
  const admin = createAdminClient();
  if (b.delete) {
    await admin.from("social_campaigns").delete().eq("id", b.promo_id).eq("workspace_id", workspaceId);
    return NextResponse.json({ ok: true });
  }
  if (b.regenerate) {
    await admin.from("social_campaigns").update({ graphics_status: "generating", updated_at: new Date().toISOString() }).eq("id", b.promo_id).eq("workspace_id", workspaceId);
    await inngest.send({ name: "social/promo.graphics", data: { workspace_id: workspaceId, campaign_id: b.promo_id } });
    return NextResponse.json({ ok: true });
  }
  await admin.from("social_campaigns").update({ active: !!b.active, updated_at: new Date().toISOString() }).eq("id", b.promo_id).eq("workspace_id", workspaceId);
  return NextResponse.json({ ok: true });
}
