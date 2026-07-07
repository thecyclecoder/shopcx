import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { cookies } from "next/headers";
import { inngest } from "@/lib/inngest/client";
import { evaluateRules } from "@/lib/rules-engine";
import { calculateRetentionScore } from "@/lib/retention-score";
import { dispatchSlackNotification } from "@/lib/slack-notify";

// GET: ticket detail with messages and customer
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Get ticket
  const { data: ticket } = await admin
    .from("tickets")
    .select("*")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!ticket) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get messages
  const { data: messages } = await admin
    .from("ticket_messages")
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  // Enrich messages with author names — display_name from workspace_members for the
  // specific author_ids (and the assigned user) in scope, plus a targeted getUserById
  // per id for the auth.users email (workspace_members doesn't store email). No
  // auth.users scan.
  const authorIds = [...new Set(messages?.filter((m) => m.author_id).map((m) => m.author_id))];
  const lookupIds = [...new Set([...authorIds, ticket.assigned_to].filter(Boolean))] as string[];

  const memberByUser = new Map<string, string | null>();
  if (lookupIds.length > 0) {
    const { data: memberRows } = await admin
      .from("workspace_members")
      .select("user_id, display_name")
      .eq("workspace_id", workspaceId)
      .in("user_id", lookupIds);
    for (const m of memberRows ?? []) memberByUser.set(m.user_id, m.display_name);
  }

  const emailByUser = new Map<string, string | null>();
  await Promise.all(
    lookupIds.map(async (uid) => {
      const { data } = await admin.auth.admin.getUserById(uid);
      emailByUser.set(uid, data.user?.email ?? null);
    }),
  );

  const userMap = new Map<string, { name: string | null; email: string | null }>(
    lookupIds.map((uid) => {
      const email = emailByUser.get(uid) ?? null;
      return [uid, { name: memberByUser.get(uid) || email, email }];
    }),
  );

  const enrichedMessages = messages?.map((m) => ({
    ...m,
    author_name: m.author_id ? userMap.get(m.author_id)?.name ?? null : null,
    author_email: m.author_id ? userMap.get(m.author_id)?.email ?? null : null,
  }));

  // Get customer with recent orders
  let customer = null;
  if (ticket.customer_id) {
    const { data: c } = await admin
      .from("customers")
      .select("*")
      .eq("id", ticket.customer_id)
      .single();

    if (c) {
      // Get linked customer IDs for combined data
      const linkedCustomerIds = [c.id];
      const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", c.id).single();
      if (link) {
        const { data: groupLinks } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
        for (const gl of groupLinks || []) {
          if (!linkedCustomerIds.includes(gl.customer_id)) linkedCustomerIds.push(gl.customer_id);
        }
      }

      const { data: orders } = await admin
        .from("orders")
        .select("id, shopify_order_id, order_number, total_cents, currency, financial_status, fulfillment_status, delivery_status, source_name, order_type, line_items, fulfillments, shipping_address, created_at")
        .in("customer_id", linkedCustomerIds)
        .order("created_at", { ascending: false })
        .limit(10);

      // Attach the order_refunds mirror rows per order. The tickets
      // detail view renders these refund lines as the authoritative
      // "what was refunded, when, via which vendor" — the raw
      // orders.financial_status badge no longer stands alone
      // (refund-integrity Phase 1). Scoped by workspace so a linked
      // cross-workspace order can't leak refund data.
      const orderIds = (orders || []).map((o) => o.id);
      const refundsByOrder = new Map<string, { id: string; vendor: string; vendor_refund_id: string | null; amount_cents: number; status: string; requested_at: string; settled_at: string | null }[]>();
      if (orderIds.length) {
        const { data: refundRows } = await admin
          .from("order_refunds")
          .select("id, order_id, vendor, vendor_refund_id, amount_cents, status, requested_at, settled_at")
          .eq("workspace_id", workspaceId)
          .in("order_id", orderIds)
          .order("requested_at", { ascending: false });
        for (const r of refundRows || []) {
          const list = refundsByOrder.get(r.order_id) || [];
          list.push({
            id: r.id,
            vendor: r.vendor,
            vendor_refund_id: r.vendor_refund_id,
            amount_cents: r.amount_cents,
            status: r.status,
            requested_at: r.requested_at,
            settled_at: r.settled_at,
          });
          refundsByOrder.set(r.order_id, list);
        }
      }
      const ordersWithRefunds = (orders || []).map((o) => ({
        ...o,
        order_refunds: refundsByOrder.get(o.id) || [],
      }));

      const { data: subscriptionsRaw } = await admin
        .from("subscriptions")
        .select("id, status, billing_interval, billing_interval_count, next_billing_date, last_payment_status, items, applied_discounts, is_internal, delivery_price_cents")
        .in("customer_id", linkedCustomerIds)
        .order("created_at", { ascending: false });
      // Price internal-sub items via the engine so the ticket widget doesn't show
      // $NaN (internal items carry no baked price_cents).
      const { priceSubItemsForDisplay } = await import("@/lib/portal/helpers/enrich-pricing");
      const subscriptions = await Promise.all(
        (subscriptionsRaw || []).map(async (s) => ({ ...s, items: await priceSubItemsForDisplay(workspaceId, s) })),
      );

      // LTV + order count come live from the orders table via the helper —
      // the customers row's denormalized columns drift.
      const { getCustomerStats } = await import("@/lib/customer-stats");
      const stats = await getCustomerStats(c.id);

      // Recalculate retention score with real data
      const lastOrder = orders?.[0];
      const retentionInput = {
        id: c.id,
        last_order_at: lastOrder?.created_at || c.last_order_at,
        total_orders: stats.total_orders,
        ltv_cents: stats.ltv_cents,
        subscription_status: c.subscription_status,
      };
      const realRetention = calculateRetentionScore(retentionInput);

      // Get linked identities for sidebar
      let linkedIdentities: { id: string; email: string; first_name: string | null; last_name: string | null; is_primary: boolean }[] = [];
      if (link) {
        const { data: groupLinks } = await admin
          .from("customer_links")
          .select("customer_id, is_primary, customers(id, email, first_name, last_name)")
          .eq("group_id", link.group_id);

        linkedIdentities = (groupLinks || [])
          .filter((l) => l.customer_id !== c.id)
          .map((l) => {
            const cust = l.customers as unknown as { id: string; email: string; first_name: string | null; last_name: string | null };
            return { id: cust.id, email: cust.email, first_name: cust.first_name, last_name: cust.last_name, is_primary: l.is_primary };
          });
      }

      customer = {
        ...c,
        total_orders: stats.total_orders,
        ltv_cents: stats.ltv_cents,
        retention_score: realRetention,
        recent_orders: ordersWithRefunds,
        subscriptions: subscriptions || [],
        linked_identities: linkedIdentities,
      };
    }
  }

  // Get assigned user name
  let assignedName = null;
  if (ticket.assigned_to) {
    assignedName = userMap.get(ticket.assigned_to)?.name || null;
  }

  // Get sandbox mode
  const { data: ws } = await admin
    .from("workspaces")
    .select("sandbox_mode, resend_domain, shopify_myshopify_domain")
    .eq("id", workspaceId)
    .single();

  const sandboxMode = ws?.sandbox_mode ?? true;
  const inboundAddress = ws?.resend_domain ? `inbound@${ws.resend_domain}` : null;
  const isInboundTicket = ticket.received_at_email === inboundAddress || !ticket.received_at_email;

  return NextResponse.json({
    ticket: { ...ticket, assigned_name: assignedName },
    messages: enrichedMessages || [],
    customer,
    sandbox_mode: sandboxMode,
    email_live: !sandboxMode || isInboundTicket,
    shopify_domain: ws?.shopify_myshopify_domain || null,
  });
}

// PATCH: update ticket
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();
  const body = await request.json();

  // Verify ticket belongs to workspace. `escalated_at`/`escalated_to` +
  // `analyzer_locked` are read here (not just for the ownership check)
  // so the analyzer-veto auto-set below can detect "was previously
  // escalated" without a second round trip. Phase 2 of
  // human-directives-hard-gates-over-ticket-ai.
  const { data: existing } = await admin
    .from("tickets")
    .select("id, status, workspace_id, customer_id, subject, escalated_at, escalated_to, analyzer_locked")
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId)
    .single();

  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Archived tickets are permanently read-only
  if (existing.status === "archived") {
    return NextResponse.json({ error: "Archived tickets cannot be modified" }, { status: 400 });
  }

  // Cancel a pending outbound message
  if (body.cancel_pending_message) {
    await admin.from("ticket_messages").update({ send_cancelled: true }).eq("id", body.cancel_pending_message).eq("ticket_id", ticketId);
    return NextResponse.json({ success: true });
  }

  // Edit a pending outbound message
  if (body.edit_pending_message && body.new_body) {
    const html = `<p>${(body.new_body as string).replace(/\n/g, "</p><p>")}</p>`;
    await admin.from("ticket_messages").update({ body: html }).eq("id", body.edit_pending_message).eq("ticket_id", ticketId).is("sent_at", null);
    return NextResponse.json({ success: true });
  }

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("status" in body) {
    updates.status = body.status;
    if (body.status === "closed" && existing.status !== "closed") {
      updates.resolved_at = new Date().toISOString();
      updates.closed_at = new Date().toISOString();
    }
    // Re-opening a closed ticket resets the archive clock
    if (body.status === "open" && existing.status === "closed") {
      updates.closed_at = null;
    }
    // Resolving always clears escalation — escalation is an open-state concept,
    // so a ticket that ends up closed/resolved/archived-and-still-flagged would
    // vanish from active views while looking unhandled (it would also linger on
    // the Escalated list). Mirrors maybeAutoCloseGroup + the merge path, which
    // unescalate before closing/archiving. Reopening does NOT auto-re-escalate.
    if (body.status === "closed" || body.status === "resolved" || body.status === "archived") {
      updates.escalated_to = null;
      updates.escalated_at = null;
      updates.escalation_reason = null;
    }
    // CSAT disabled — will be reimplemented differently
  }

  if ("assigned_to" in body) updates.assigned_to = body.assigned_to || null;
  if ("tags" in body) updates.tags = body.tags;
  // Human directive — per-ticket "turn off AI" hard gate. Non-propagating on
  // merge (see src/lib/ticket-merge.ts). Sets actor + timestamp on flip so the
  // audit trail survives even if the toggle is later re-enabled; clearing
  // wipes both. Phase 1 of human-directives-hard-gates-over-ticket-ai.
  let aiDisabledAudit: { toDisabled: boolean } | null = null;
  if ("ai_disabled" in body) {
    const next = !!body.ai_disabled;
    updates.ai_disabled = next;
    updates.ai_disabled_by = next ? user.id : null;
    updates.ai_disabled_at = next ? new Date().toISOString() : null;
    aiDisabledAudit = { toDisabled: next };
  }

  // Human veto — analyzer_locked. Phase 2 of
  // human-directives-hard-gates-over-ticket-ai. Two entry points:
  //   1. Explicit `analyzer_locked` toggle from the dashboard button.
  //   2. Auto-set when a human manually closes + unescalates a
  //      previously-escalated ticket in the SAME request — that
  //      close+unescalate IS the veto ("I reviewed this, do not
  //      re-open it"). We detect it here (before the escalation clear
  //      overwrites the existing flags on the row we already read) and
  //      merge into updates. The explicit toggle wins if both are set.
  const existingWithGate = existing as unknown as {
    escalated_at?: string | null;
    escalated_to?: string | null;
    analyzer_locked?: boolean;
    status?: string;
  };
  const priorEscalated = !!(existingWithGate.escalated_at || existingWithGate.escalated_to);
  const closingNow = "status" in body && (body.status === "closed" || body.status === "resolved")
    && existing.status !== "closed" && existing.status !== "resolved";
  let analyzerLockedAudit: { toLocked: boolean; reason: "explicit_toggle" | "auto_close_veto" } | null = null;
  if ("analyzer_locked" in body) {
    const next = !!body.analyzer_locked;
    updates.analyzer_locked = next;
    updates.locked_by = next ? user.id : null;
    updates.locked_at = next ? new Date().toISOString() : null;
    analyzerLockedAudit = { toLocked: next, reason: "explicit_toggle" };
  } else if (
    closingNow &&
    priorEscalated &&
    !existingWithGate.analyzer_locked
  ) {
    updates.analyzer_locked = true;
    updates.locked_by = user.id;
    updates.locked_at = new Date().toISOString();
    analyzerLockedAudit = { toLocked: true, reason: "auto_close_veto" };
  }
  if ("csat_score" in body) updates.csat_score = body.csat_score;
  if ("auto_reply_at" in body) updates.auto_reply_at = body.auto_reply_at;
  // Escalate to the AI Routine: escalated_at set + escalated_to = null (the
  // idle-triage cron's "routine-owned" signal). Distinct from "not escalated"
  // (both have escalated_to null), so it needs its own flag — a falsy
  // escalated_to below means de-escalate and clears escalated_at.
  if (body.escalate_to_routine) {
    updates.escalated_to = null;
    updates.escalated_at = new Date().toISOString();
    updates.escalation_reason =
      ("escalation_reason" in body ? body.escalation_reason : null) || "Escalated to AI Routine";
  } else if ("escalated_to" in body) {
    updates.escalated_to = body.escalated_to || null;
    updates.escalated_at = body.escalated_to ? new Date().toISOString() : null;
    if ("escalation_reason" in body) updates.escalation_reason = body.escalation_reason || null;
  }
  if ("snoozed_until" in body) {
    updates.snoozed_until = body.snoozed_until || null;
  }

  const { data: updated, error } = await admin
    .from("tickets")
    .update(updates)
    .eq("id", ticketId)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Audit note for the ai_disabled toggle — cite the actor so the trail
  // survives a later re-enable. Only fires when the field was in the
  // request, so a normal PATCH doesn't spam ticket_messages.
  const needsActorLookup = !!(aiDisabledAudit || analyzerLockedAudit);
  let actorName = "A team member";
  if (needsActorLookup) {
    const { data: actor } = await admin
      .from("workspace_members")
      .select("display_name")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id)
      .maybeSingle();
    actorName = actor?.display_name || user.email || "A team member";
  }
  if (aiDisabledAudit) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: aiDisabledAudit.toDisabled
        ? `[System] ${actorName} turned OFF the AI on this ticket. The handler + auto-analysis will skip it until AI is re-enabled.`
        : `[System] ${actorName} re-enabled the AI on this ticket.`,
    });
  }
  if (analyzerLockedAudit) {
    const suffix = analyzerLockedAudit.reason === "auto_close_veto"
      ? " (auto — closed + unescalated a previously-escalated ticket)"
      : "";
    await admin.from("ticket_messages").insert({
      ticket_id: ticketId,
      direction: "outbound",
      visibility: "internal",
      author_type: "system",
      body: analyzerLockedAudit.toLocked
        ? `[System] ${actorName} LOCKED the analyzer on this ticket${suffix}. The auto-analysis cron will skip it and will not re-open + escalate, even on a severe-type or threat-keyword override.`
        : `[System] ${actorName} unlocked the analyzer on this ticket. The auto-analysis cron may re-select it again.`,
    });
  }

  // Evaluate rules on status change
  if ("status" in body && body.status !== existing.status) {
    const { data: custData } = updated.customer_id
      ? await admin.from("customers").select("*").eq("id", updated.customer_id).single()
      : { data: null };
    await evaluateRules(workspaceId, "ticket.status_changed", {
      ticket: updated,
      customer: custData || undefined,
    });
  }

  // Slack notification on manual escalation
  if ("escalated_to" in body && body.escalated_to) {
    const { data: member } = await admin
      .from("workspace_members")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", body.escalated_to)
      .single();

    const { data: custData } = updated.customer_id
      ? await admin.from("customers").select("first_name, email").eq("id", updated.customer_id).single()
      : { data: null };

    dispatchSlackNotification(workspaceId, "escalation", {
      ticketId,
      ticketNumber: updated.subject || ticketId,
      customer: { name: custData?.first_name || undefined, email: custData?.email },
      reason: body.escalation_reason || "Manual escalation",
      assignedMemberId: member?.id,
    }).catch(() => {});
  }

  return NextResponse.json(updated);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: ticketId } = await params;
  void request;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const cookieStore = await cookies();
  const workspaceId = cookieStore.get("workspace_id")?.value;
  if (!workspaceId) return NextResponse.json({ error: "No workspace" }, { status: 400 });

  const admin = createAdminClient();

  // Owner/admin only
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .single();

  if (!member || !["owner", "admin"].includes(member.role)) {
    return NextResponse.json({ error: "Only owner or admin can delete tickets" }, { status: 403 });
  }

  // Pre-clear FK references that would block the delete. Most refs use
  // ON DELETE SET NULL or CASCADE, but a few are NO ACTION and need
  // explicit handling:
  //   • tickets.merged_into → unmerge children before deleting the parent.
  //     This was the silent-failure mode on f71a31e6 (2026-05-27):
  //     messages CASCADE-deleted, parent ticket DELETE rejected by FK
  //     constraint, error was swallowed and the UI showed success.
  //   • returns.ticket_id, store_credit_log.ticket_id → also NO ACTION;
  //     null them out to allow the delete. The returns/credit history
  //     stays; only the back-pointer to the ticket is cleared.
  await admin.from("tickets").update({ merged_into: null }).eq("merged_into", ticketId);
  await admin.from("returns").update({ ticket_id: null }).eq("ticket_id", ticketId);
  await admin.from("store_credit_log").update({ ticket_id: null }).eq("ticket_id", ticketId);

  // Messages cascade on FK so this is belt-and-suspenders, but explicit
  // is fine and surfaces errors if the table ever changes.
  const { error: msgErr } = await admin.from("ticket_messages").delete().eq("ticket_id", ticketId);
  if (msgErr) {
    console.error("[delete-ticket] ticket_messages delete failed:", msgErr.message);
    return NextResponse.json({ error: `Failed to delete messages: ${msgErr.message}` }, { status: 500 });
  }

  const { error: tErr, count } = await admin
    .from("tickets")
    .delete({ count: "exact" })
    .eq("id", ticketId)
    .eq("workspace_id", workspaceId);
  if (tErr) {
    console.error("[delete-ticket] ticket delete failed:", tErr.message);
    return NextResponse.json({ error: `Failed to delete ticket: ${tErr.message}` }, { status: 500 });
  }
  if (count === 0) {
    return NextResponse.json({ error: "Ticket not found or not in this workspace" }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
}
