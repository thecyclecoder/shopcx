import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logCustomerEvent } from "@/lib/customer-events";

export function jsonOk(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status });
}

export function jsonErr(body: Record<string, unknown>, status = 400) {
  return NextResponse.json({ ok: false, ...body }, { status });
}

export function clampInt(n: unknown, fallback: number): number {
  const x = Number(n);
  return Number.isFinite(x) ? Math.trunc(x) : fallback;
}

export function shortId(gid: unknown): string {
  const s = String(gid || "");
  if (!s) return "";
  const parts = s.split("/");
  return parts[parts.length - 1] || s;
}

export function addDaysFromNow(days: number): string {
  const ms = Date.now() + days * 24 * 60 * 60 * 1000 + 15 * 60 * 1000;
  return new Date(ms).toISOString();
}

/**
 * Find customer in our DB by Shopify customer ID.
 */
export async function findCustomer(workspaceId: string, shopifyCustomerId: string) {
  if (!workspaceId || !shopifyCustomerId) return null;
  const admin = createAdminClient();
  const { data } = await admin.from("customers")
    .select("id, email, first_name, last_name, shopify_customer_id, default_address")
    .eq("workspace_id", workspaceId)
    .eq("shopify_customer_id", shopifyCustomerId)
    .single();
  return data;
}

/**
 * Log a portal action to customer_events and optionally create an internal ticket note.
 */
export async function logPortalAction(params: {
  workspaceId: string;
  customerId: string;
  eventType: string;
  summary: string;
  properties?: Record<string, unknown>;
  createNote?: boolean;
}) {
  const { workspaceId, customerId, eventType, summary, properties, createNote } = params;

  await logCustomerEvent({
    workspaceId,
    customerId,
    eventType,
    source: "portal",
    summary,
    properties: properties || {},
  });

  if (createNote) {
    const admin = createAdminClient();
    // Find most recent open/pending ticket for this customer
    const { data: ticket } = await admin.from("tickets")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("customer_id", customerId)
      .in("status", ["open", "pending"])
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (ticket) {
      await admin.from("ticket_messages").insert({
        ticket_id: ticket.id,
        direction: "internal",
        visibility: "internal",
        author_type: "system",
        body: `[Portal] ${summary}`,
      });
    }
  }
}

/**
 * Wrap Appstle errors into portal-friendly responses.
 */
export function handleAppstleError(e: unknown): NextResponse {
  const err = e as { message?: string; status?: number; details?: unknown };
  if (err?.message === "Appstle not configured") {
    return jsonErr({ error: "missing_appstle_config" }, 500);
  }
  return jsonErr({
    error: "appstle_error",
    message: err?.message || "Unknown error",
  }, 502);
}
