import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Crisis enrollment lookup for the ticket sidebar card. Returns
 * every active-crisis enrollment for this customer (and any linked
 * profiles) + the parent crisis_event details so the card can render
 * human-readable variant names. Only includes rows whose crisis is
 * still `status='active'` — resolved crises shouldn't surface a card.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; customerId: string }> },
) {
  const { id: workspaceId, customerId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  // Resolve linked customer profiles so the card surfaces enrollments
  // on any of them (mirrors the orchestrator's lookup).
  const linked = new Set<string>([customerId]);
  const { data: myLinks } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId);
  const groupIds = (myLinks || []).map((r) => r.group_id);
  if (groupIds.length) {
    const { data: members } = await admin
      .from("customer_links")
      .select("customer_id")
      .in("group_id", groupIds);
    for (const m of members || []) linked.add(m.customer_id);
  }

  const { data: actions } = await admin
    .from("crisis_customer_actions")
    .select("id, crisis_id, customer_id, segment, current_tier, paused_at, auto_resume, removed_item_at, auto_readd, cancelled, ticket_id, subscription_id, original_item, updated_at")
    .eq("workspace_id", workspaceId)
    .in("customer_id", Array.from(linked))
    .order("updated_at", { ascending: false });

  if (!actions?.length) return NextResponse.json({ enrollments: [] });

  const crisisIds = Array.from(new Set(actions.map((a) => a.crisis_id)));
  const { data: crises } = await admin
    .from("crisis_events")
    .select("id, name, status, affected_product_title, default_swap_title, expected_restock_date, affected_variant_id, default_swap_variant_id")
    .in("id", crisisIds);
  const crisisById = new Map((crises || []).map((c) => [c.id, c]));

  // Only return rows whose parent crisis is still active.
  const enrollments = actions
    .map((a) => ({ action: a, crisis: crisisById.get(a.crisis_id) || null }))
    .filter((e) => e.crisis && e.crisis.status === "active");

  return NextResponse.json({ enrollments });
}
