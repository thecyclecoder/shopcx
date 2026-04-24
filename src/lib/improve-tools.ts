/**
 * Data tools for the Improve tab — delegates to Sonnet v2's shared tool executor.
 * Single source of truth: sonnet-orchestrator-v2.ts executeToolCall()
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { executeToolCall } from "@/lib/sonnet-orchestrator-v2";

type Ticket = { id: string; customer_email?: string; [key: string]: unknown };

async function resolveCustomerId(workspaceId: string, ticket: Ticket): Promise<string> {
  const admin = createAdminClient();
  const { data: t } = await admin.from("tickets").select("customer_id").eq("id", ticket.id).single();
  if (t?.customer_id) return t.customer_id;
  if (ticket.customer_email) {
    const { data: c } = await admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("email", ticket.customer_email).single();
    if (c?.id) return c.id;
  }
  return "";
}

export default async function executeToolCallImprove(
  name: string,
  input: Record<string, unknown>,
  workspaceId: string,
  ticket: Ticket,
): Promise<string> {
  const custId = await resolveCustomerId(workspaceId, ticket);
  if (!custId && name !== "get_product_knowledge") {
    return "No customer found for this ticket.";
  }
  return executeToolCall(name, input, workspaceId, custId, ticket.id);
}
