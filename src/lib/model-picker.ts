/**
 * Picks the orchestrator model (Sonnet vs Opus) per ticket. Broad Opus
 * triggers — at our ticket volume even all-Opus is ~$420/mo, well below
 * the cost of a part-time CSR. The aim is reliability, not penny-pinching:
 * Sonnet is reserved for the obviously-trivial first touch.
 *
 * Signals (any one trips Opus):
 *   • ai_turn_count >= 1 — turn 1 didn't close the ticket
 *   • Complex tags: crisis*, pb:*, j:cancel*, wb, dunning:active, fraud
 *   • Active crisis enrollment for this customer
 *   • Linked accounts (customer_links row exists for this customer)
 *   • Customer has 2+ active subscriptions
 *   • Recently merged into this ticket (sibling row with merged_into=tid in last 24h)
 *   • Customer LTV >= $200
 *
 * Returns { model, reason } so we can stamp `purpose` on ai_token_usage
 * with WHY Opus was chosen — that's how we audit "did Opus actually help?"
 */
import { createAdminClient } from "@/lib/supabase/admin";

export type OrchestratorModel = "sonnet" | "opus";

export interface ModelPick {
  model: OrchestratorModel;
  reason: string;
}

const COMPLEX_TAG_PREFIXES = ["crisis", "pb:", "j:cancel", "fraud"];
const COMPLEX_TAGS_EXACT = ["wb", "dunning:active"];
const LTV_OPUS_THRESHOLD_CENTS = 20000; // $200

export async function pickOrchestratorModel(params: {
  workspaceId: string;
  ticketId: string;
  customerId: string | null;
}): Promise<ModelPick> {
  const { workspaceId, ticketId, customerId } = params;
  const admin = createAdminClient();
  const reasons: string[] = [];

  // Pull the ticket + customer in parallel
  const [{ data: ticket }, { data: customer }] = await Promise.all([
    admin
      .from("tickets")
      .select("ai_turn_count, tags")
      .eq("id", ticketId)
      .maybeSingle(),
    customerId
      ? admin
          .from("customers")
          .select("ltv_cents")
          .eq("id", customerId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  // Turn count
  if ((ticket?.ai_turn_count || 0) >= 1) reasons.push(`turn>=${ticket?.ai_turn_count || 0}`);

  // Complex tags
  const tags: string[] = (ticket?.tags as string[]) || [];
  const hitTag = tags.find(
    t =>
      COMPLEX_TAG_PREFIXES.some(p => t.startsWith(p)) ||
      COMPLEX_TAGS_EXACT.includes(t),
  );
  if (hitTag) reasons.push(`tag=${hitTag}`);

  // LTV
  const ltvCents = (customer as { ltv_cents?: number } | null)?.ltv_cents || 0;
  if (ltvCents >= LTV_OPUS_THRESHOLD_CENTS) reasons.push(`ltv=$${Math.round(ltvCents / 100)}`);

  if (customerId) {
    // Run the customer-keyed signals in parallel
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [crisis, links, subs, merges] = await Promise.all([
      // Active crisis enrollment in flight (not yet resolved at tier 3)
      admin
        .from("crisis_customer_actions")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("customer_id", customerId)
        .is("tier3_response", null)
        .is("paused_at", null)
        .is("removed_item_at", null)
        .eq("cancelled", false),
      // Linked accounts — count siblings in same group
      admin
        .from("customer_links")
        .select("group_id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("customer_id", customerId),
      // Active subscriptions
      admin
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("customer_id", customerId)
        .eq("status", "active"),
      // Recently merged into this ticket
      admin
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("merged_into", ticketId)
        .gte("updated_at", since24h),
    ]);

    if ((crisis.count || 0) > 0) reasons.push("crisis-enrollment");
    if ((links.count || 0) > 0) reasons.push("linked-accounts");
    if ((subs.count || 0) >= 2) reasons.push(`active-subs=${subs.count}`);
    if ((merges.count || 0) > 0) reasons.push("recently-merged");
  }

  if (reasons.length === 0) {
    return { model: "sonnet", reason: "default" };
  }

  return { model: "opus", reason: reasons.join("+") };
}
