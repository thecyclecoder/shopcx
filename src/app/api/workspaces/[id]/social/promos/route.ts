import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

async function requireUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user;
}

// Create a promo (the way an operator declares a holiday/seasonal campaign).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  if (!(await requireUser())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const b = await req.json();
  if (!b.name || !b.starts_on || !b.ends_on || !b.brief) return NextResponse.json({ error: "name, starts_on, ends_on, brief required" }, { status: 400 });
  const admin = createAdminClient();
  const { data, error } = await admin.from("social_campaigns").insert({
    workspace_id: workspaceId,
    name: b.name, starts_on: b.starts_on, ends_on: b.ends_on, brief: b.brief,
    emphasis_product_id: b.emphasis_product_id || null,
    boost_per_platform_per_day: b.boost_per_platform_per_day || null,
    active: b.active !== false,
  }).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
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
  await admin.from("social_campaigns").update({ active: !!b.active, updated_at: new Date().toISOString() }).eq("id", b.promo_id).eq("workspace_id", workspaceId);
  return NextResponse.json({ ok: true });
}
