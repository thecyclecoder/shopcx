import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";

export const submitBanRequest: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const subject = String(payload?.subject || "Portal request");
  const message = String(payload?.message || "").trim();
  if (!message) return jsonErr({ error: "missing_message" }, 400);

  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  const admin = createAdminClient();

  // Create ticket for the ban request
  await admin.from("tickets").insert({
    workspace_id: auth.workspaceId,
    customer_id: customer.id,
    subject: `[Portal Request] ${subject}`,
    status: "open",
    channel: "portal",
    tags: ["portal:ban_request"],
  });

  // Add the customer's message as the first ticket message
  const { data: ticket } = await admin.from("tickets")
    .select("id")
    .eq("workspace_id", auth.workspaceId)
    .eq("customer_id", customer.id)
    .eq("channel", "portal")
    .order("created_at", { ascending: false })
    .limit(1)
    .single();

  if (ticket) {
    await admin.from("ticket_messages").insert({
      ticket_id: ticket.id,
      direction: "in",
      visibility: "external",
      author_type: "customer",
      body: `Subject: ${subject}\n\n${message}`,
    });
  }

  return jsonOk({
    ok: true,
    route,
    message: "Your request has been submitted. We'll get back to you within 24 hours.",
  });
};
