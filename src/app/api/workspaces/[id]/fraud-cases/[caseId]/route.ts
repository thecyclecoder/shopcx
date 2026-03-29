import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeOrderTags } from "@/lib/shopify-order-tags";

// GET: Single fraud case with matches and history
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  const { id: workspaceId, caseId } = await params;
  void request;

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

  const { data: fraudCase, error } = await admin
    .from("fraud_cases")
    .select("*, fraud_rules(name, description, rule_type)")
    .eq("id", caseId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error || !fraudCase) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Load matches
  const { data: matches } = await admin
    .from("fraud_rule_matches")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });

  // Load history
  const { data: history } = await admin
    .from("fraud_case_history")
    .select("*, users:user_id(email, raw_user_meta_data)")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });

  // Load assigned member info
  let assignedMember = null;
  if (fraudCase.assigned_to) {
    const { data: m } = await admin
      .from("workspace_members")
      .select("id, user_id, users:user_id(email, raw_user_meta_data)")
      .eq("id", fraudCase.assigned_to)
      .single();
    assignedMember = m;
  }

  // Load workspace members for assignment dropdown
  const { data: members } = await admin
    .from("workspace_members")
    .select("id, user_id, role, users:user_id(email, raw_user_meta_data)")
    .eq("workspace_id", workspaceId)
    .in("role", ["owner", "admin"]);

  return NextResponse.json({
    case: fraudCase,
    matches: matches || [],
    history: history || [],
    assigned_member: assignedMember,
    members: members || [],
  });
}

// PATCH: Update fraud case (status, assignment, review)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  const { id: workspaceId, caseId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();

  const { data: member } = await admin
    .from("workspace_members")
    .select("id, role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();
  const { status, assigned_to, review_notes, resolution, dismissal_reason } = body;

  // Load current case
  const { data: current } = await admin
    .from("fraud_cases")
    .select("status, assigned_to")
    .eq("id", caseId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!current) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Validate status transitions
  if (status === "confirmed_fraud" && !review_notes) {
    return NextResponse.json({ error: "Review notes required to confirm fraud" }, { status: 400 });
  }
  if (status === "dismissed" && !dismissal_reason) {
    return NextResponse.json({ error: "Dismissal reason required" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  const historyEntries: { action: string; old_value: string | null; new_value: string | null; notes: string | null }[] = [];

  if (status && status !== current.status) {
    updates.status = status;
    historyEntries.push({
      action: "status_changed",
      old_value: current.status,
      new_value: status,
      notes: null,
    });

    if (status === "confirmed_fraud" || status === "dismissed") {
      updates.reviewed_by = member.id;
      updates.reviewed_at = new Date().toISOString();
    }
    if (status === "reviewing" && !current.assigned_to) {
      updates.assigned_to = member.id;
      historyEntries.push({
        action: "assigned",
        old_value: null,
        new_value: member.id,
        notes: "Auto-assigned on review start",
      });
    }
  }

  if (assigned_to !== undefined && assigned_to !== current.assigned_to) {
    updates.assigned_to = assigned_to;
    historyEntries.push({
      action: "assigned",
      old_value: current.assigned_to,
      new_value: assigned_to,
      notes: null,
    });
  }

  if (review_notes !== undefined) updates.review_notes = review_notes;
  if (resolution !== undefined) updates.resolution = resolution;
  if (dismissal_reason !== undefined) updates.dismissal_reason = dismissal_reason;

  if (Object.keys(updates).length > 0) {
    await admin
      .from("fraud_cases")
      .update(updates)
      .eq("id", caseId);
  }

  // Insert history entries
  if (historyEntries.length > 0) {
    await admin.from("fraud_case_history").insert(
      historyEntries.map((h) => ({
        case_id: caseId,
        workspace_id: workspaceId,
        user_id: user.id,
        ...h,
      }))
    );
  }

  // If dismissed → remove "suspicious" tag from held orders to release them
  if (status === "dismissed") {
    const { data: dismissedCase } = await admin
      .from("fraud_cases")
      .select("order_ids, orders_held")
      .eq("id", caseId)
      .single();

    if (dismissedCase?.orders_held && dismissedCase.order_ids?.length) {
      for (const orderId of dismissedCase.order_ids as string[]) {
        if (orderId) {
          removeOrderTags(workspaceId, orderId, ["suspicious"]).catch((err) => {
            console.error(`Failed to remove suspicious tag from order ${orderId}:`, err);
          });
        }
      }

      // Mark orders as no longer held
      await admin.from("fraud_cases").update({ orders_held: false }).eq("id", caseId);
    }
  }

  // If dismissed as false positive family/household, suppress the address
  if (status === "dismissed" && dismissal_reason === "False positive — family/household") {
    const { data: dismissedCase } = await admin
      .from("fraud_cases")
      .select("evidence")
      .eq("id", caseId)
      .single();

    if (dismissedCase?.evidence?.address) {
      const address = (dismissedCase.evidence as { address?: string }).address;
      if (address) {
        await admin.rpc("append_suppressed_address", {
          p_workspace_id: workspaceId,
          p_address: address,
        });
      }
    }
  }

  return NextResponse.json({ ok: true });
}

// DELETE: Remove a fraud case (admin/owner only)
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  const { id: workspaceId, caseId } = await params;
  void request;

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

  // Clear fraud_case_id references on chargeback_events
  await admin
    .from("chargeback_events")
    .update({ fraud_case_id: null })
    .eq("fraud_case_id", caseId);

  // Delete related records first
  await admin.from("fraud_case_history").delete().eq("case_id", caseId);
  await admin.from("fraud_rule_matches").delete().eq("case_id", caseId);
  await admin.from("fraud_cases").delete().eq("id", caseId).eq("workspace_id", workspaceId);

  return NextResponse.json({ deleted: true });
}
