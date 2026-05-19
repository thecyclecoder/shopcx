/**
 * verify_grandfathered_pricing — proactive recipe. Detects when a
 * customer's active subscription line items are priced HIGHER than
 * what their historical order pattern shows they used to pay.
 *
 * Doesn't require an AI claim to trigger — fires whenever the analyzer
 * flags a severe issue on a ticket where the customer has at least
 * one active sub. The signal is purely structural: median historical
 * sub-rate vs current sub-rate, per variant.
 *
 * Gap type:
 *   pricing_drift:<contract_id>:<variant_id> — current price > historical typical price by ≥$4 AND ≥5%
 *
 * Proposed heal:
 *   update_line_item_price with base = historical_unit_price / 0.75
 *   (Appstle applies the 25% sellingPlan discount → customer pays the
 *   historical rate at next renewal.)
 *
 * Skips proposing a heal (escalates instead) when:
 *   - <3 historical orders for the variant (single anomaly, can't be sure)
 *   - The historical price was a clear one-time MSRP outlier (no repeats)
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getSubsForCustomer } from "@/lib/research/probes/subscription";
import type { ResearchRecipe, Finding, Gap, ProposedHeal } from "@/lib/research/types";

const SLUG = "verify_grandfathered_pricing";
const VERSION = 1;

// Meaningful-drift thresholds: only propose if BOTH are exceeded.
const MIN_GAP_CENTS = 400;        // $4/box
const MIN_GAP_FRACTION = 0.05;    // 5%

export const verifyGrandfatheredPricing: ResearchRecipe = {
  slug: SLUG,
  version: VERSION,
  description: "Detect when active sub line items are priced higher than the customer's historical typical rate, propose update_line_item_price heal.",
  run: async (ticketId: string) => {
    const admin = createAdminClient();
    const findings: Finding[] = [];
    const gaps: Gap[] = [];

    const { data: ticket } = await admin
      .from("tickets")
      .select("workspace_id, customer_id")
      .eq("id", ticketId)
      .single();
    if (!ticket?.customer_id) {
      return { findings: [{ type: "no_customer", subject: ticketId, evidence: {}, severity: "info" }], gaps: [] };
    }

    // Resolve linked customer ids — historical orders may live on a
    // pre-link profile that we've since merged into the current customer.
    const linkedIds = await resolveLinkedIds(admin, ticket.customer_id);

    const subs = await getSubsForCustomer(ticket.workspace_id, ticket.customer_id);
    const activeSubs = subs.filter(s => s.status === "active" || s.status === "paused");
    if (activeSubs.length === 0) {
      return {
        findings: [{ type: "no_active_subs", subject: ticket.customer_id, evidence: {}, severity: "info" }],
        gaps: [],
      };
    }

    // Pull orders for all linked profiles. line_items is JSONB; we walk
    // in JS rather than asking Postgres to flatten — cleaner code, the
    // typical customer has <50 orders.
    const { data: orders } = await admin
      .from("orders")
      .select("order_number, created_at, line_items")
      .in("customer_id", linkedIds)
      .order("created_at", { ascending: false })
      .limit(100);

    findings.push({
      type: "history_snapshot",
      subject: "customer_orders",
      evidence: { order_count: (orders || []).length, active_sub_count: activeSubs.length },
      severity: "info",
    });

    for (const sub of activeSubs) {
      // Some subs have multiple line items for the same variant (e.g.,
      // a swap that left both the old and new line in place). Process
      // each variant once per sub — the heal call updates all matching
      // lines at the Appstle level. Use the highest current price so
      // we don't under-report the drift.
      const variantsSeen = new Set<string>();
      const itemsSorted = [...sub.items].sort((a, b) => (b.price_cents || 0) - (a.price_cents || 0));
      for (const item of itemsSorted) {
        if (!item.variant_id || !item.price_cents) continue;
        if (variantsSeen.has(item.variant_id)) continue;
        variantsSeen.add(item.variant_id);
        const currentCents = item.price_cents;

        // Collect every historical price the customer paid for this variant.
        const historicalPrices: number[] = [];
        for (const o of orders || []) {
          const lines = (o.line_items as Array<Record<string, unknown>>) || [];
          for (const li of lines) {
            const liVariantId = String(li.variant_id || li.shopify_variant_id || "");
            const liPrice = Number(li.price_cents || 0);
            if (liVariantId === String(item.variant_id) && liPrice > 0) {
              historicalPrices.push(liPrice);
            }
          }
        }

        if (historicalPrices.length === 0) {
          findings.push({
            type: "no_history_for_variant",
            subject: `${sub.contract_id}:${item.variant_id}`,
            evidence: { variant_title: item.variant_title, current_cents: currentCents },
            severity: "info",
          });
          continue;
        }

        // Frequency map — the customer's most common historical rate for
        // this variant is the strongest "grandfathered" signal. Ties
        // resolve to the lowest, because we want to restore the customer
        // to the better deal they ever held.
        const freq = new Map<number, number>();
        for (const p of historicalPrices) freq.set(p, (freq.get(p) || 0) + 1);
        // Sort by frequency desc, then price asc
        const sortedByFreq = [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
        const [typicalCents, typicalCount] = sortedByFreq[0];

        const gapCents = currentCents - typicalCents;
        const gapFraction = currentCents > 0 ? gapCents / currentCents : 0;

        if (gapCents < MIN_GAP_CENTS || gapFraction < MIN_GAP_FRACTION) {
          findings.push({
            type: "pricing_aligned",
            subject: `${sub.contract_id}:${item.variant_id}`,
            evidence: {
              variant_title: item.variant_title,
              current_cents: currentCents,
              typical_cents: typicalCents,
              typical_count: typicalCount,
              gap_cents: gapCents,
              gap_fraction: Math.round(gapFraction * 100) / 100,
            },
            severity: "info",
          });
          continue;
        }

        // Meaningful drift. Build the gap. Only propose a heal when
        // the typical price has at least 3 confirming occurrences —
        // single-shot historical prices could be discount events,
        // returns, or one-time promo orders that don't reflect a real
        // grandfathered rate.
        const baseCents = Math.round(typicalCents / 0.75);
        const subjectLabel = item.variant_title ? `${item.title || ""} — ${item.variant_title}` : (item.title || item.variant_id);
        let proposedHeal: ProposedHeal | undefined;
        if (typicalCount >= 3) {
          proposedHeal = {
            action_type: "update_line_item_price",
            params: {
              contract_id: sub.contract_id,
              variant_id: item.variant_id,
              base_price_cents: baseCents,
              variant_title: subjectLabel,
            },
            customer_message_template: "Following up — I restored your previous pricing on your subscription. Going forward you'll be charged ${{value}} per box on your renewals.",
            customer_message_persona: "suzie",
          };
        }

        gaps.push({
          gap_id: `pricing_drift:${sub.contract_id}:${item.variant_id}`,
          description: `Subscription ${sub.contract_id} line item ${subjectLabel} is priced at $${(currentCents / 100).toFixed(2)} per box, but the customer historically paid $${(typicalCents / 100).toFixed(2)} ${typicalCount} time${typicalCount === 1 ? "" : "s"} on past orders. Gap: $${(gapCents / 100).toFixed(2)} (${Math.round(gapFraction * 100)}%).${proposedHeal ? "" : " Not auto-healed — historical price seen only once or twice, escalate for agent review."}`,
          severity: gapFraction >= 0.15 ? "high" : "medium",
          proposed_heal: proposedHeal,
        });
      }
    }

    return { findings, gaps };
  },
};

async function resolveLinkedIds(admin: ReturnType<typeof createAdminClient>, customerId: string): Promise<string[]> {
  const { data: link } = await admin.from("customer_links").select("group_id").eq("customer_id", customerId).maybeSingle();
  if (!link?.group_id) return [customerId];
  const { data: group } = await admin.from("customer_links").select("customer_id").eq("group_id", link.group_id);
  return (group || []).map(r => r.customer_id as string);
}
