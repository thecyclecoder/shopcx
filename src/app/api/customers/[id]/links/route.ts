import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveWorkspaceId } from "@/lib/workspace";

// GET: get linked customers for a customer
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: customerId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Find group for this customer
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .single();

  if (!link) {
    return NextResponse.json({ linked: [], group_id: null });
  }

  // Get all customers in this group
  const { data: groupLinks } = await admin
    .from("customer_links")
    .select("customer_id, is_primary, customers(id, email, first_name, last_name, phone, retention_score, total_orders, ltv_cents, subscription_status)")
    .eq("workspace_id", workspaceId)
    .eq("group_id", link.group_id);

  const linked: Record<string, unknown>[] = (groupLinks || [])
    .filter((l) => l.customer_id !== customerId)
    .map((l) => ({
      ...(l.customers as unknown as Record<string, unknown>),
      is_primary: l.is_primary,
    }));

  // LTV + total_orders come live from the orders table.
  if (linked.length) {
    const { getCustomerStatsBatch } = await import("@/lib/customer-stats");
    const ids = linked.map(c => c.id as string).filter(Boolean);
    const stats = await getCustomerStatsBatch(ids);
    for (const c of linked) {
      const s = stats.get(c.id as string);
      if (s) { c.ltv_cents = s.ltv_cents; c.total_orders = s.total_orders; }
    }
  }

  return NextResponse.json({ linked, group_id: link.group_id });
}

// POST: link a customer to this one
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: customerId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin", "agent"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { link_to } = body; // customer ID to link to

  if (!link_to) return NextResponse.json({ error: "link_to required" }, { status: 400 });
  if (link_to === customerId) return NextResponse.json({ error: "Cannot link to self" }, { status: 400 });

  // Verify both customers exist in this workspace
  const { data: customer } = await admin
    .from("customers")
    .select("id")
    .eq("id", customerId)
    .eq("workspace_id", workspaceId)
    .single();

  const { data: target } = await admin
    .from("customers")
    .select("id")
    .eq("id", link_to)
    .eq("workspace_id", workspaceId)
    .single();

  if (!customer || !target) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // Check if either already has a group
  const { data: existingLink } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .single();

  const { data: targetLink } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", link_to)
    .single();

  let groupId: string;

  if (existingLink && targetLink) {
    // Both already in groups — merge groups
    if (existingLink.group_id === targetLink.group_id) {
      return NextResponse.json({ error: "Already linked" }, { status: 409 });
    }
    // Move target's group into this group
    groupId = existingLink.group_id;
    await admin
      .from("customer_links")
      .update({ group_id: groupId })
      .eq("group_id", targetLink.group_id);
  } else if (existingLink) {
    // Add target to existing group
    groupId = existingLink.group_id;
    const { error } = await admin.from("customer_links").insert({
      workspace_id: workspaceId,
      group_id: groupId,
      customer_id: link_to,
      is_primary: false,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else if (targetLink) {
    // Add this customer to target's group
    groupId = targetLink.group_id;
    const { error } = await admin.from("customer_links").insert({
      workspace_id: workspaceId,
      group_id: groupId,
      customer_id: customerId,
      is_primary: false,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    // Create new group with both
    const { randomUUID } = await import("crypto");
    groupId = randomUUID();
    const { error: insertError } = await admin.from("customer_links").insert([
      {
        workspace_id: workspaceId,
        group_id: groupId,
        customer_id: customerId,
        is_primary: true,
      },
      {
        workspace_id: workspaceId,
        group_id: groupId,
        customer_id: link_to,
        is_primary: false,
      },
    ]);
    if (insertError) {
      console.error("Link insert error:", insertError.message);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ group_id: groupId });
}

// DELETE: unlink a customer from its group
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: customerId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const workspaceId = await getActiveWorkspaceId();
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  const { searchParams } = new URL(request.url);
  const unlinkId = searchParams.get("unlink_id");

  if (!unlinkId) return NextResponse.json({ error: "unlink_id required" }, { status: 400 });

  // Remove the link
  await admin
    .from("customer_links")
    .delete()
    .eq("customer_id", unlinkId)
    .eq("workspace_id", workspaceId);

  // If only one customer left in group, remove that link too (no group of 1)
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customerId)
    .single();

  if (link) {
    const { count } = await admin
      .from("customer_links")
      .select("id", { count: "exact", head: true })
      .eq("group_id", link.group_id);

    if (count === 1) {
      await admin
        .from("customer_links")
        .delete()
        .eq("group_id", link.group_id);
    }
  }

  return NextResponse.json({ ok: true });
}
