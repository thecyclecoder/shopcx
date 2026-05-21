import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan, logPortalAction } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Portal route: list the customer's support tickets.
 *
 * Excludes merged tickets (merged_into IS NOT NULL — those are
 * confusing, the canonical thread lives elsewhere) and archived /
 * do_not_reply tickets (the AI explicitly decided to stop engaging
 * those; surfacing them invites duplicate reply threads).
 *
 * Spans linked customer profiles so a customer who's emailed us
 * from a sibling email sees those tickets here too.
 */
export const supportList: RouteHandler = async ({ auth, route }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();
  // Linked accounts — same expansion pattern as other portal handlers.
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customer.id)
    .maybeSingle();
  let ids = [customer.id];
  if (link?.group_id) {
    const { data: g } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id);
    ids = (g || []).map((r) => r.customer_id as string);
    if (!ids.includes(customer.id)) ids.push(customer.id);
  }

  const { data: tickets } = await admin
    .from("tickets")
    .select("id, subject, status, channel, created_at, updated_at, last_message_at, merged_into, do_not_reply")
    .eq("workspace_id", auth.workspaceId)
    .in("customer_id", ids)
    .is("merged_into", null)
    .neq("status", "archived")
    .eq("do_not_reply", false)
    .order("created_at", { ascending: false })
    .limit(50);

  return jsonOk({ ok: true, route, tickets: tickets || [] });
};

/**
 * Portal route: fetch a single ticket + its messages (external only;
 * internal notes stay hidden from the customer view).
 */
export const supportTicket: RouteHandler = async ({ auth, route, url }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const ticketId = url.searchParams.get("ticketId");
  if (!ticketId) return jsonErr({ error: "missing_ticketId" }, 400);

  const admin = createAdminClient();
  // Verify ownership across linked accounts.
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customer.id)
    .maybeSingle();
  let ids = [customer.id];
  if (link?.group_id) {
    const { data: g } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id);
    ids = (g || []).map((r) => r.customer_id as string);
    if (!ids.includes(customer.id)) ids.push(customer.id);
  }

  const { data: ticket } = await admin
    .from("tickets")
    .select("id, subject, status, channel, customer_id, created_at, merged_into, do_not_reply")
    .eq("id", ticketId)
    .eq("workspace_id", auth.workspaceId)
    .in("customer_id", ids)
    .maybeSingle();

  if (!ticket || ticket.merged_into || ticket.do_not_reply) {
    return jsonErr({ error: "ticket_not_available" }, 404);
  }

  const { data: messages } = await admin
    .from("ticket_messages")
    .select("id, direction, author_type, body_clean, body, created_at")
    .eq("ticket_id", ticketId)
    .eq("visibility", "external")
    .order("created_at", { ascending: true });

  return jsonOk({ ok: true, route, ticket, messages: messages || [] });
};

/**
 * Portal route: customer posts a reply on an existing ticket. The
 * reply is inserted as a normal inbound ticket_message so the
 * unified ticket handler picks it up (Sonnet/agent gets routed
 * exactly the same way as an email or chat reply).
 */
export const supportReply: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: { ticketId?: string; body?: string } | null = null;
  try { payload = await req.json(); } catch { payload = null; }
  if (!payload?.ticketId || !payload.body?.trim()) {
    return jsonErr({ error: "missing_ticketId_or_body" }, 400);
  }

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();
  // Linked account expansion + ownership check.
  const { data: link } = await admin
    .from("customer_links")
    .select("group_id")
    .eq("customer_id", customer.id)
    .maybeSingle();
  let ids = [customer.id];
  if (link?.group_id) {
    const { data: g } = await admin
      .from("customer_links")
      .select("customer_id")
      .eq("group_id", link.group_id);
    ids = (g || []).map((r) => r.customer_id as string);
    if (!ids.includes(customer.id)) ids.push(customer.id);
  }

  const { data: ticket } = await admin
    .from("tickets")
    .select("id, status, channel, merged_into, do_not_reply")
    .eq("id", payload.ticketId)
    .eq("workspace_id", auth.workspaceId)
    .in("customer_id", ids)
    .maybeSingle();
  if (!ticket || ticket.merged_into || ticket.do_not_reply) {
    return jsonErr({ error: "ticket_not_available" }, 404);
  }

  const body = payload.body.trim().slice(0, 5000);

  // Insert as a regular inbound external message. The unified
  // ticket handler picks up new inbound messages and routes them
  // (AI orchestrator, agent assignment, etc.).
  const { data: msg, error } = await admin
    .from("ticket_messages")
    .insert({
      ticket_id: payload.ticketId,
      direction: "inbound",
      visibility: "external",
      author_type: "customer",
      body,
      body_clean: body,
    })
    .select("id")
    .single();
  if (error || !msg) {
    return jsonErr({ error: "message_insert_failed", message: error?.message }, 500);
  }

  // Re-open the ticket if it was closed — the customer is engaging
  // again and the handler should pick it up.
  if (ticket.status === "closed" || ticket.status === "pending") {
    await admin
      .from("tickets")
      .update({ status: "open", updated_at: new Date().toISOString(), last_message_at: new Date().toISOString() })
      .eq("id", payload.ticketId);
  } else {
    await admin
      .from("tickets")
      .update({ updated_at: new Date().toISOString(), last_message_at: new Date().toISOString() })
      .eq("id", payload.ticketId);
  }

  await logPortalAction({
    workspaceId: auth.workspaceId, customerId: customer.id,
    eventType: "portal.support.reply_sent",
    summary: `Customer replied on ticket ${payload.ticketId} via portal`,
    properties: { ticket_id: payload.ticketId },
    createNote: false,
  });

  return jsonOk({ ok: true, route, message_id: msg.id });
};

/**
 * Portal route: create a new support ticket from the portal.
 */
export const supportCreate: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);
  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: { subject?: string; body?: string } | null = null;
  try { payload = await req.json(); } catch { payload = null; }
  if (!payload?.body?.trim()) return jsonErr({ error: "missing_body" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();
  const subject = (payload.subject || "").trim().slice(0, 200) || payload.body.trim().slice(0, 60);
  const body = payload.body.trim().slice(0, 5000);

  const { data: ticket, error } = await admin
    .from("tickets")
    .insert({
      workspace_id: auth.workspaceId,
      customer_id: customer.id,
      subject,
      channel: "help_center",  // Portal-originated; treated the same as help-center widget
      status: "open",
      last_message_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !ticket) {
    return jsonErr({ error: "ticket_insert_failed", message: error?.message }, 500);
  }

  await admin.from("ticket_messages").insert({
    ticket_id: ticket.id,
    direction: "inbound",
    visibility: "external",
    author_type: "customer",
    body,
    body_clean: body,
  });

  await logPortalAction({
    workspaceId: auth.workspaceId, customerId: customer.id,
    eventType: "portal.support.ticket_created",
    summary: `Customer opened ticket "${subject}" via portal`,
    properties: { ticket_id: ticket.id },
    createNote: false,
  });

  return jsonOk({ ok: true, route, ticket_id: ticket.id });
};
