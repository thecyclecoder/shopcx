import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";

// PATCH: Update fraud rule config
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; ruleId: string }> }
) {
  const { id: workspaceId, ruleId } = await params;

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

  const body = await request.json();
  const { name, config, severity, is_active } = body;

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (name !== undefined) updates.name = name;
  if (config !== undefined) updates.config = config;
  if (severity !== undefined) updates.severity = severity;
  if (is_active !== undefined) updates.is_active = is_active;

  const { error } = await admin
    .from("fraud_rules")
    .update(updates)
    .eq("id", ruleId)
    .eq("workspace_id", workspaceId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Trigger a re-run of fraud detection after config change
  await inngest.send({
    name: "fraud/rule.updated",
    data: { ruleId, workspaceId },
  });

  return NextResponse.json({ ok: true });
}
