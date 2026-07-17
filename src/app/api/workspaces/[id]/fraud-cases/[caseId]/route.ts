import { NextResponse } from "next/server";
import { getAuthedUser } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { removeOrderTags } from "@/lib/shopify-order-tags";
import { createAmplifierOrder } from "@/lib/integrations/amplifier";
import { buildPackingSlipMessage } from "@/lib/packing-slip-message";

// GET: Single fraud case with matches and history
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  const { id: workspaceId, caseId } = await params;
  void request;

  const { user } = await getAuthedUser();
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

  // Load history (acting-user email/name resolved below — auth.users is NOT embeddable via
  // PostgREST, so the old `users:user_id(...)` embed 400'd and the user column silently read
  // "System" for everyone).
  const { data: history } = await admin
    .from("fraud_case_history")
    .select("*")
    .eq("case_id", caseId)
    .order("created_at", { ascending: true });

  // Load assigned member (id + user_id; email resolved below)
  let assignedMember: { id: string; user_id: string | null } | null = null;
  if (fraudCase.assigned_to) {
    const { data: m } = await admin
      .from("workspace_members")
      .select("id, user_id")
      .eq("id", fraudCase.assigned_to)
      .maybeSingle();
    assignedMember = m;
  }

  // Resolve emails/names in one call via the ticket_users RPC (SECURITY DEFINER,
  // workspace_members ⋈ auth.users), then reshape into the { users: { email, raw_user_meta_data } }
  // contract the fraud detail page reads (display_name → raw_user_meta_data.full_name).
  const historyRows = (history || []) as Array<{ user_id: string | null }>;
  const userIds = [
    ...new Set(
      [...historyRows.map((h) => h.user_id), assignedMember?.user_id ?? null].filter(
        (v): v is string => !!v,
      ),
    ),
  ];
  const userMap = new Map<string, { email: string | null; raw_user_meta_data: { full_name?: string } }>();
  if (userIds.length) {
    const { data: us } = await admin.rpc("ticket_users", {
      p_workspace: workspaceId,
      p_user_ids: userIds,
    });
    for (const u of (us || []) as Array<{ user_id: string; display_name: string | null; email: string | null }>) {
      userMap.set(u.user_id, { email: u.email, raw_user_meta_data: { full_name: u.display_name ?? undefined } });
    }
  }
  const withUser = <T extends { user_id: string | null }>(row: T) => ({
    ...row,
    users: row.user_id ? userMap.get(row.user_id) ?? null : null,
  });

  // Load workspace members for assignment dropdown
  const { data: members } = await admin
    .from("workspace_members")
    .select("id, user_id, role, display_name")
    .eq("workspace_id", workspaceId)
    .in("role", ["owner", "admin", "agent"]);

  return NextResponse.json({
    case: fraudCase,
    matches: matches || [],
    history: historyRows.map(withUser),
    assigned_member: assignedMember ? withUser(assignedMember) : null,
    members: members || [],
  });
}

// PATCH: Update fraud case (status, assignment, review)
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; caseId: string }> }
) {
  const { id: workspaceId, caseId } = await params;

  const { user } = await getAuthedUser();
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
  // Review notes are optional for confirmed fraud
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

  // If dismissed → release each held order to fulfillment.
  //   - Internal storefront orders: never sent to Amplifier in the
  //     first place (the held state IS the absence of an
  //     amplifier_order_id). Fire Amplifier now. If it fails, abort
  //     the dismiss with a 502 so the operator sees the error and can
  //     retry — silent fallback would leave an "approved" case with a
  //     paid order that the warehouse never sees.
  //   - Shopify-sourced orders: remove the "suspicious" tag in Shopify.
  if (status === "dismissed") {
    const { data: dismissedCase } = await admin
      .from("fraud_cases")
      .select("order_ids, orders_held")
      .eq("id", caseId)
      .single();

    if (dismissedCase?.order_ids?.length) {
      const amplifierFailures: Array<{ order_number: string; error?: string; details?: string }> = [];

      for (const orderId of dismissedCase.order_ids as string[]) {
        if (!orderId) continue;

        // Non-UUID → legacy/Shopify-side only; no local row to look up.
        if (!orderId.includes("-")) {
          removeOrderTags(workspaceId, orderId, ["suspicious"]).catch((err) => {
            console.error(`Failed to remove suspicious tag from order ${orderId}:`, err);
          });
          continue;
        }

        const { data: order } = await admin
          .from("orders")
          .select("id, order_number, customer_id, source_name, shopify_order_id, amplifier_order_id, email, shipping_address, billing_address, line_items, total_cents, created_at")
          .eq("id", orderId)
          .maybeSingle();
        if (!order) continue;

        if (order.source_name === "storefront") {
          if (order.amplifier_order_id) continue; // already released
          type Line = {
            sku?: string | null;
            title: string;
            variant_title?: string | null;
            quantity: number;
            unit_price_cents: number;
            variant_id?: string;
            product_id?: string;
            is_gift?: boolean;
          };
          const ship = order.shipping_address as { phone?: string; first_name?: string } | null;
          const lines = (order.line_items as Line[]) || [];
          // Founder note — same logic as checkout-time. Counts prior
          // orders (this one excluded) to pick first-time vs returning.
          const distinctProducts = new Set(lines.filter((l) => l.sku && l.product_id).map((l) => l.product_id as string)).size;
          const packingSlipMessage = order.customer_id ? await buildPackingSlipMessage({
            workspaceId,
            customerId: order.customer_id as string,
            orderId: order.id as string,
            firstName: ship?.first_name || "",
            productCount: distinctProducts,
          }) : null;
          const res = await createAmplifierOrder({
            workspaceId,
            orderNumber: order.order_number as string,
            orderDate: order.created_at as string,
            shippingAddress: order.shipping_address,
            billingAddress: order.billing_address,
            email: order.email as string,
            phone: ship?.phone || null,
            // Send every line with a SKU including gifts; gifts ship
            // at $0 so the warehouse pick sheet shows them.
            lineItems: lines
              .filter((l) => l.sku)
              .map((l) => ({
                sku: l.sku!,
                title: l.title,
                description: l.variant_title ? `${l.title} — ${l.variant_title}` : l.title,
                quantity: l.quantity,
                unit_price_cents: l.unit_price_cents,
                reference_id: l.variant_id,
              })),
            totalCents: order.total_cents,
            subtotalCents: order.total_cents,
            shippingCents: 0,
            taxCents: 0,
            packingSlipMessage: packingSlipMessage || undefined,
          });
          if (res.success && res.amplifier_order_id) {
            await admin
              .from("orders")
              .update({
                amplifier_order_id: res.amplifier_order_id,
                amplifier_received_at: new Date().toISOString(),
              })
              .eq("id", order.id);
          } else {
            console.error(`[fraud-dismiss] Amplifier release failed for ${order.order_number}:`, res.error, res.details);
            amplifierFailures.push({ order_number: order.order_number as string, error: res.error, details: res.details });
          }
        } else if (order.shopify_order_id) {
          removeOrderTags(workspaceId, order.shopify_order_id, ["suspicious"]).catch((err) => {
            console.error(`Failed to remove suspicious tag from order ${order.shopify_order_id}:`, err);
          });
        }
      }

      // If ANY internal-order release failed, surface a 502 instead of
      // silently completing the dismiss — the operator needs to know
      // there's a paid order sitting un-fulfilled. We still let the
      // status field update succeed (above) so the case isn't
      // re-evaluated by the engine, but flag it so retry is possible.
      if (amplifierFailures.length > 0) {
        await admin.from("dashboard_notifications").insert({
          workspace_id: workspaceId,
          type: "fraud_alert",
          title: `Amplifier release failed on ${amplifierFailures.length} order(s)`,
          body: amplifierFailures
            .map((f) => `${f.order_number}: ${f.error || ""} ${f.details || ""}`.trim())
            .join(" · "),
        }).then(() => undefined, () => undefined);
        return NextResponse.json(
          {
            error: "amplifier_release_failed",
            details: "Case is marked dismissed but the order(s) below failed to release to Amplifier. Retry the dismiss to re-fire, or place the order manually in Amplifier.",
            failures: amplifierFailures,
          },
          { status: 502 },
        );
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

  const { user } = await getAuthedUser();
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
