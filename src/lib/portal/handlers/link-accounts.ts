import type { RouteHandler } from "@/lib/portal/types";
import { jsonOk, jsonErr, findCustomer, logPortalAction, checkPortalBan } from "@/lib/portal/helpers";
import { createAdminClient } from "@/lib/supabase/admin";
import crypto from "crypto";

export const linkAccounts: RouteHandler = async ({ auth, route, req }) => {
  if (!auth.loggedInCustomerId) return jsonErr({ error: "not_logged_in" }, 401);

  const banCheck = await checkPortalBan(auth.workspaceId, auth.loggedInCustomerId);
  if (banCheck) return banCheck;

  let payload: Record<string, unknown> | null = null;
  try { payload = await req.json(); } catch { payload = null; }

  const action = (payload?.action as string) || "";
  const selectedIds = (payload?.selected_ids as string[]) || [];
  const rejectedIds = (payload?.rejected_ids as string[]) || [];

  if (!action || !["link", "reject_all", "skip"].includes(action)) {
    return jsonErr({ error: "invalid action" }, 400);
  }

  const admin = createAdminClient();
  const customer = await findCustomer(auth.workspaceId, auth.loggedInCustomerId);
  if (!customer) return jsonErr({ error: "customer_not_found" }, 404);

  if (action === "skip") {
    return jsonOk({ ok: true, route, action: "skipped" });
  }

  if (action === "reject_all") {
    // Reject all unlinked matches — never prompt again
    const { findUnlinkedMatches } = await import("@/lib/account-matching");
    const matches = await findUnlinkedMatches(auth.workspaceId, customer.id, admin);
    for (const m of matches) {
      if (m.id) {
        await admin.from("customer_link_rejections").upsert({
          customer_id: customer.id,
          rejected_customer_id: m.id,
          workspace_id: auth.workspaceId,
        }, { onConflict: "customer_id,rejected_customer_id" });
      }
    }
    await logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: "portal.link.rejected_all",
      summary: `Customer rejected all ${matches.length} potential account links`,
    });
    return jsonOk({ ok: true, route, action: "rejected_all", count: matches.length });
  }

  // action === "link"
  if (selectedIds.length === 0 && rejectedIds.length === 0) {
    return jsonErr({ error: "no_selections" }, 400);
  }

  // Block linking to banned customers
  if (selectedIds.length > 0) {
    const { data: bannedTargets } = await admin.from("customers")
      .select("id")
      .in("id", selectedIds)
      .eq("portal_banned", true);
    if (bannedTargets?.length) {
      return jsonErr({ error: "cannot_link_banned_account" }, 403);
    }
  }

  // Link selected accounts
  if (selectedIds.length > 0) {
    // Check if customer already has a group
    const { data: existingLink } = await admin.from("customer_links")
      .select("group_id").eq("customer_id", customer.id).maybeSingle();

    const groupId = existingLink?.group_id || crypto.randomUUID();

    // Ensure current customer is in the group
    if (!existingLink) {
      await admin.from("customer_links").upsert({
        workspace_id: auth.workspaceId,
        customer_id: customer.id,
        group_id: groupId,
        is_primary: true,
      }, { onConflict: "customer_id" });
    }

    // Add selected accounts to the group
    for (const id of selectedIds) {
      await admin.from("customer_links").upsert({
        workspace_id: auth.workspaceId,
        customer_id: id,
        group_id: groupId,
        is_primary: false,
      }, { onConflict: "customer_id" });
    }

    await logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: "portal.link.linked",
      summary: `Customer linked ${selectedIds.length} account(s) via portal`,
      properties: { linked_ids: selectedIds },
    });
  }

  // Reject unselected accounts
  for (const id of rejectedIds) {
    await admin.from("customer_link_rejections").upsert({
      customer_id: customer.id,
      rejected_customer_id: id,
      workspace_id: auth.workspaceId,
    }, { onConflict: "customer_id,rejected_customer_id" });
  }

  if (rejectedIds.length) {
    await logPortalAction({
      workspaceId: auth.workspaceId,
      customerId: customer.id,
      eventType: "portal.link.rejected",
      summary: `Customer rejected ${rejectedIds.length} account link(s)`,
      properties: { rejected_ids: rejectedIds },
    });
  }

  return jsonOk({ ok: true, route, action: "linked", linked: selectedIds.length, rejected: rejectedIds.length });
};
