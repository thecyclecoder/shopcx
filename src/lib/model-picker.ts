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
 *
 * LTV alone no longer trips Opus — Phase 1 of
 * docs/brain/specs/model-picker-routes-on-state-not-tags-ltv-stops-buying-opus.md.
 * The 142-ticket blind replay found 78% of Opus tickets downgrade-safe within 1
 * grade pt; crisis-enrollment + linked-accounts (not LTV) were the axes that
 * correlated with the genuinely-hard buckets. A high-value first-touch trivial
 * ticket now runs on Sonnet.
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

export interface ModelSignals {
  aiTurnCount: number;
  tags: string[];
  crisisCount: number;
  linksCount: number;
  activeSubsCount: number;
  recentMergesCount: number;
}

const COMPLEX_TAG_PREFIXES = ["crisis", "pb:", "j:cancel", "fraud"];
const COMPLEX_TAGS_EXACT = ["wb", "dunning:active"];

/**
 * Pure decision core: given the collected signals, decide the model + why.
 * Kept separate from `pickOrchestratorModel` so the routing rule is unit-
 * testable without touching the DB.
 */
export function pickModelFromSignals(signals: ModelSignals): ModelPick {
  const reasons: string[] = [];

  if (signals.aiTurnCount >= 1) reasons.push(`turn>=${signals.aiTurnCount}`);

  const hitTag = signals.tags.find(
    t =>
      COMPLEX_TAG_PREFIXES.some(p => t.startsWith(p)) ||
      COMPLEX_TAGS_EXACT.includes(t),
  );
  if (hitTag) reasons.push(`tag=${hitTag}`);

  if (signals.crisisCount > 0) reasons.push("crisis-enrollment");
  if (signals.linksCount > 0) reasons.push("linked-accounts");
  if (signals.activeSubsCount >= 2) reasons.push(`active-subs=${signals.activeSubsCount}`);
  if (signals.recentMergesCount > 0) reasons.push("recently-merged");

  if (reasons.length === 0) return { model: "sonnet", reason: "default" };
  return { model: "opus", reason: reasons.join("+") };
}

export async function pickOrchestratorModel(params: {
  workspaceId: string;
  ticketId: string;
  customerId: string | null;
}): Promise<ModelPick> {
  const { workspaceId, ticketId, customerId } = params;
  const admin = createAdminClient();

  const { data: ticket } = await admin
    .from("tickets")
    .select("ai_turn_count, tags")
    .eq("id", ticketId)
    .maybeSingle();

  const aiTurnCount = ticket?.ai_turn_count || 0;
  const tags: string[] = (ticket?.tags as string[]) || [];

  let crisisCount = 0;
  let linksCount = 0;
  let activeSubsCount = 0;
  let recentMergesCount = 0;

  if (customerId) {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [crisis, links, subs, merges] = await Promise.all([
      admin
        .from("crisis_customer_actions")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("customer_id", customerId)
        .is("tier3_response", null)
        .is("paused_at", null)
        .is("removed_item_at", null)
        .eq("cancelled", false),
      admin
        .from("customer_links")
        .select("group_id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("customer_id", customerId),
      admin
        .from("subscriptions")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .eq("customer_id", customerId)
        .eq("status", "active"),
      admin
        .from("tickets")
        .select("id", { count: "exact", head: true })
        .eq("merged_into", ticketId)
        .gte("updated_at", since24h),
    ]);

    crisisCount = crisis.count || 0;
    linksCount = links.count || 0;
    activeSubsCount = subs.count || 0;
    recentMergesCount = merges.count || 0;
  }

  return pickModelFromSignals({
    aiTurnCount,
    tags,
    crisisCount,
    linksCount,
    activeSubsCount,
    recentMergesCount,
  });
}
