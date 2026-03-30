import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const admin = createAdminClient();

  const { data, error } = await admin.from("remedies").insert({
    workspace_id: workspaceId,
    name: body.name || "Untitled",
    type: body.type || "coupon",
    description: body.description || "",
    is_active: body.is_active ?? true,
    priority: body.priority ?? 0,
    config: body.coupon_mapping_id
      ? { ...((body.config || {}) as object), coupon_mapping_id: body.coupon_mapping_id }
      : body.config || {},
  }).select("id").single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, id: data?.id });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const admin = createAdminClient();

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.type !== undefined) update.type = body.type;
  if (body.description !== undefined) update.description = body.description;
  if (body.is_active !== undefined) update.is_active = body.is_active;
  if (body.priority !== undefined) update.priority = body.priority;
  if (body.config !== undefined) update.config = body.config;
  if (body.coupon_mapping_id !== undefined) {
    update.config = { ...((body.config || {}) as object), coupon_mapping_id: body.coupon_mapping_id };
  }

  await admin.from("remedies")
    .update(update)
    .eq("id", body.id)
    .eq("workspace_id", workspaceId);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: workspaceId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const remedyId = new URL(req.url).searchParams.get("id");
  if (!remedyId) return NextResponse.json({ error: "missing_id" }, { status: 400 });

  const admin = createAdminClient();
  await admin.from("remedies").delete().eq("id", remedyId).eq("workspace_id", workspaceId);

  return NextResponse.json({ ok: true });
}
