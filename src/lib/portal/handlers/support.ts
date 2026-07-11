import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, checkPortalBan, logPortalAction } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import { dispatchInboundMessage } from "@/lib/inngest/dispatch-inbound-message";

/**
 * Portal route: list the customer's support tickets.
 *
 * Shows the customer their full history INCLUDING archived /
 * do_not_reply tickets — those come back flagged `read_only` (display,
 * no reply box). Only merged stubs are hidden (the canonical thread
 * lives at the merge target). Spans linked customer profiles so a
 * customer who emailed from a sibling address sees those tickets too.
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
    .select("id, subject, status, channel, created_at, updated_at, last_customer_reply_at, merged_into, do_not_reply")
    .eq("workspace_id", auth.workspaceId)
    .in("customer_id", ids)
    .is("merged_into", null) // hide merge stubs only
    .order("created_at", { ascending: false })
    .limit(50);

  // Archived / do_not_reply tickets are shown but read-only (no reply box).
  const shaped = (tickets || []).map((t) => ({
    ...t,
    read_only: t.status === "archived" || !!t.do_not_reply,
  }));

  return jsonOk({ ok: true, route, tickets: shaped });
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

  // Merge stubs redirect elsewhere — not viewable. Archived / do_not_reply
  // ARE viewable, just read-only (flagged so the UI hides the reply box).
  if (!ticket || ticket.merged_into) {
    return jsonErr({ error: "ticket_not_available" }, 404);
  }
  const readOnly = ticket.status === "archived" || !!ticket.do_not_reply;

  const { data: messages } = await admin
    .from("ticket_messages")
    .select("id, direction, author_type, body_clean, body, created_at")
    .eq("ticket_id", ticketId)
    .eq("visibility", "external")
    .order("created_at", { ascending: true });

  return jsonOk({ ok: true, route, ticket: { ...ticket, read_only: readOnly }, messages: messages || [] });
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
  if (!ticket || ticket.merged_into) {
    return jsonErr({ error: "ticket_not_available" }, 404);
  }
  // Read-only tickets can't be replied to (archived = resolved history,
  // do_not_reply = we deliberately stopped engaging).
  if (ticket.status === "archived" || ticket.do_not_reply) {
    return jsonErr({ error: "ticket_read_only", message: "This conversation is closed. Start a new request instead." }, 403);
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
      .update({ status: "open", updated_at: new Date().toISOString(), last_customer_reply_at: new Date().toISOString() })
      .eq("id", payload.ticketId);
  } else {
    await admin
      .from("tickets")
      .update({ updated_at: new Date().toISOString(), last_customer_reply_at: new Date().toISOString() })
      .eq("id", payload.ticketId);
  }

  // Kick the unified ticket handler via the durable dispatcher — stamps intent on `msg` then
  // fires the event. Inserting the message alone does NOT trigger the handler.
  await dispatchInboundMessage({
    admin,
    workspaceId: auth.workspaceId,
    ticketId: payload.ticketId,
    messageBody: body,
    channel: ticket.channel || "portal",
    isNewTicket: false,
    dispatchMessageId: msg.id,
  });

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
      channel: "portal",  // Portal-originated; gets its own AI Agent Channel config (mirrors live chat)
      status: "open",
      last_customer_reply_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !ticket) {
    return jsonErr({ error: "ticket_insert_failed", message: error?.message }, 500);
  }

  const { data: createMsg } = await admin.from("ticket_messages").insert({
    ticket_id: ticket.id,
    direction: "inbound",
    visibility: "external",
    author_type: "customer",
    body,
    body_clean: body,
  }).select("id").single();

  // Kick the unified ticket handler via the durable dispatcher.
  await dispatchInboundMessage({
    admin,
    workspaceId: auth.workspaceId,
    ticketId: ticket.id,
    messageBody: body,
    channel: "portal",
    isNewTicket: true,
    dispatchMessageId: createMsg?.id ?? null,
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
