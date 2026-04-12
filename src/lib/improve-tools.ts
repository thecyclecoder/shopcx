/**
 * Data tools for the Improve tab — reuses Sonnet v2 data fetchers.
 * Resolves customer_id from ticket, then delegates to the orchestrator's tools.
 */

import { createAdminClient } from "@/lib/supabase/admin";

type Ticket = { id: string; customer_email?: string; [key: string]: unknown };

async function resolveCustomerId(workspaceId: string, ticket: Ticket): Promise<string | null> {
  const admin = createAdminClient();
  // Try ticket's customer_id first
  const { data: t } = await admin.from("tickets").select("customer_id").eq("id", ticket.id).single();
  if (t?.customer_id) return t.customer_id;
  // Fallback to email lookup
  if (ticket.customer_email) {
    const { data: c } = await admin.from("customers").select("id").eq("workspace_id", workspaceId).eq("email", ticket.customer_email).single();
    return c?.id || null;
  }
  return null;
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

  // Dynamically import the v2 data fetchers
  // They're not exported directly, so we replicate the key ones here
  const admin = createAdminClient();

  try {
    switch (name) {
      case "get_customer_account": {
        const [{ data: subs }, { data: orders }, { data: loyalty }] = await Promise.all([
          admin.from("subscriptions").select("shopify_contract_id, status, items, next_billing_date, billing_interval, billing_interval_count").eq("workspace_id", workspaceId).eq("customer_id", custId!).in("status", ["active", "paused", "cancelled"]).order("created_at", { ascending: false }),
          admin.from("orders").select("order_number, total_cents, line_items, created_at, financial_status, shopify_order_id").eq("workspace_id", workspaceId).eq("customer_id", custId!).order("created_at", { ascending: false }).limit(5),
          admin.from("loyalty_members").select("points_balance").eq("workspace_id", workspaceId).eq("customer_id", custId!).maybeSingle(),
        ]);
        const parts: string[] = [];
        parts.push("SUBSCRIPTIONS:");
        for (const s of subs || []) {
          const items = ((s.items as { title?: string; variant_title?: string; quantity?: number; price_cents?: number }[]) || []).map(i => `${i.title || "?"} ${i.variant_title || ""} x${i.quantity || 1} @$${((i.price_cents || 0) / 100).toFixed(2)}`).join(", ");
          const next = s.next_billing_date ? new Date(s.next_billing_date).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "?";
          parts.push(`- ${s.shopify_contract_id} | ${s.status} | ${items} | next: ${next}`);
        }
        if (!subs?.length) parts.push("- None");
        parts.push("\nRECENT ORDERS:");
        for (const o of orders || []) {
          const items = ((o.line_items as { title?: string; quantity?: number; price_cents?: number }[]) || []).map(i => `${i.title || "?"} x${i.quantity || 1} @$${((i.price_cents || 0) / 100).toFixed(2)}`).join(", ");
          parts.push(`- #${o.order_number} | ${new Date(o.created_at).toLocaleDateString()} | $${((o.total_cents || 0) / 100).toFixed(2)} | ${o.financial_status} | ${items} | shopify_order_id: ${o.shopify_order_id}`);
        }
        if (!orders?.length) parts.push("- None");
        if (loyalty) parts.push(`\nLOYALTY: ${loyalty.points_balance} points`);
        return parts.join("\n");
      }
      case "get_returns": {
        const { data: returns } = await admin.from("returns").select("status, order_number, reason, refund_amount_cents, tracking_number, created_at").eq("workspace_id", workspaceId).eq("customer_id", custId!).order("created_at", { ascending: false }).limit(5);
        if (!returns?.length) return "No returns found.";
        return returns.map(r => `- #${r.order_number} | ${r.status} | ${r.reason || "?"} | refund: $${((r.refund_amount_cents || 0) / 100).toFixed(2)} | tracking: ${r.tracking_number || "none"} | ${new Date(r.created_at).toLocaleDateString()}`).join("\n");
      }
      case "get_chargebacks": {
        const { data: cbs } = await admin.from("chargeback_events").select("status, reason, amount_cents, shopify_order_id, created_at").eq("workspace_id", workspaceId).eq("customer_id", custId!).order("created_at", { ascending: false }).limit(5);
        if (!cbs?.length) return "No chargebacks found.";
        return cbs.map(c => `- ${c.status} | ${c.reason} | $${((c.amount_cents || 0) / 100).toFixed(2)} | order: ${c.shopify_order_id} | ${new Date(c.created_at).toLocaleDateString()}`).join("\n");
      }
      case "get_email_history": {
        const { data: events } = await admin.from("email_events").select("event_type, subject, occurred_at").eq("workspace_id", workspaceId).eq("customer_id", custId!).order("occurred_at", { ascending: false }).limit(10);
        if (!events?.length) return "No email history.";
        return events.map(e => `- ${new Date(e.occurred_at).toLocaleDateString()} ${e.event_type}: "${e.subject || "?"}"`).join("\n");
      }
      case "get_crisis_status": {
        const { data: actions } = await admin.from("crisis_customer_actions").select("segment, current_tier, tier1_response, paused_at, cancelled, exhausted_at, crisis_events(affected_product_title, status)").eq("customer_id", custId!).order("created_at", { ascending: false }).limit(3);
        if (!actions?.length) return "No crisis actions.";
        return actions.map(a => {
          const ce = a.crisis_events as { affected_product_title?: string; status?: string } | null;
          return `- ${ce?.affected_product_title || "?"} (${ce?.status}) | segment: ${a.segment} | tier: ${a.current_tier} | t1: ${a.tier1_response || "pending"} | paused: ${a.paused_at ? "yes" : "no"} | cancelled: ${a.cancelled ? "yes" : "no"}`;
        }).join("\n");
      }
      case "get_dunning_status": {
        const { data: cycles } = await admin.from("dunning_cycles").select("status, cycle_number, created_at").eq("workspace_id", workspaceId).eq("customer_id", custId!).order("created_at", { ascending: false }).limit(3);
        if (!cycles?.length) return "No dunning cycles.";
        return cycles.map(c => `- Cycle #${c.cycle_number} | ${c.status} | ${new Date(c.created_at).toLocaleDateString()}`).join("\n");
      }
      case "get_product_knowledge": {
        const { retrieveContext } = await import("@/lib/rag");
        const results = await retrieveContext(workspaceId, (input.query as string) || "general", 5);
        const parts: string[] = [];
        if (results.macros?.length) {
          parts.push("MACROS:");
          for (const m of results.macros) parts.push(`- ${m.name}: ${(m.body_text || "").slice(0, 200)}`);
        }
        if (results.chunks?.length) {
          parts.push("KB ARTICLES:");
          for (const c of results.chunks) parts.push(`- ${c.kb_title}: ${c.chunk_text.slice(0, 200)}`);
        }
        return parts.join("\n") || "No matching knowledge found.";
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}
