import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: customerId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json();
  const banned = !!body.banned;

  const admin = createAdminClient();

  // Check caller is admin or owner
  const { data: member } = await admin.from("workspace_members")
    .select("id, workspace_id, role, display_name")
    .eq("user_id", user.id)
    .single();

  if (!member || !["admin", "owner"].includes(member.role)) {
    return NextResponse.json({ error: "insufficient_permissions" }, { status: 403 });
  }

  // Update customer ban status
  const update: Record<string, unknown> = {
    portal_banned: banned,
    portal_banned_at: banned ? new Date().toISOString() : null,
    portal_banned_by: banned ? member.id : null,
  };

  const { error } = await admin.from("customers")
    .update(update)
    .eq("id", customerId)
    .eq("workspace_id", member.workspace_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Create internal ticket note for audit trail
  const displayName = member.display_name || "Admin";
  const action = banned ? "banned from" : "unbanned from";
  const noteBody = `Customer ${action} portal by ${displayName}`;

  // Find most recent ticket for this customer
  const { data: ticket } = await admin.from("tickets")
    .select("id")
    .eq("workspace_id", member.workspace_id)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (ticket) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticket.id,
      direction: "internal",
      visibility: "internal",
      author_type: "system",
      body: noteBody,
    });
  }

  return NextResponse.json({ ok: true, banned });
}
