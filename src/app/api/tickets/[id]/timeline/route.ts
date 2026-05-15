import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildCustomerTimeline } from "@/lib/customer-timeline";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "no_workspace" }, { status: 400 });

  const admin = createAdminClient();
  const { data: ticket } = await admin.from("tickets")
    .select("customer_id, workspace_id")
    .eq("id", id)
    .single();
  if (!ticket) return NextResponse.json({ error: "ticket_not_found" }, { status: 404 });
  if (ticket.workspace_id !== workspaceId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  if (!ticket.customer_id) return NextResponse.json({ error: "ticket_has_no_customer" }, { status: 400 });

  const timeline = await buildCustomerTimeline(workspaceId, ticket.customer_id);
  return NextResponse.json(timeline);
}
