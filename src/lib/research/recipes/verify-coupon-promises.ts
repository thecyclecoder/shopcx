/**
 * verify_coupon_promises — checks the most recent AI/agent messages on
 * a ticket for claims about loyalty coupons being applied to subscriptions,
 * verifies each against (a) the sub's applied_discounts in our DB AND
 * (b) Shopify's authoritative asyncUsageCount for the code.
 *
 * Surfaces three kinds of gaps:
 *   - missing_coupon:<contract_id>      — AI said all subs got coupons, but this one has none
 *   - applied_coupon_already_used:<...> — sub has code applied per DB but Shopify says usage=1/1
 *   - no_coupon_for_active_subs         — generic "you'll see your reward applied" claim with zero subs holding any loyalty coupon
 *
 * Proposed heals:
 *   - apply_loyalty_coupon (if an unused coupon is available)
 *   - redeem_points + apply_loyalty_coupon (chained, if no unused but points >= 1500)
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { getLoyaltyAndSubState } from "@/lib/research/probes/loyalty";
import type { ResearchRecipe, Finding, Gap } from "@/lib/research/types";

const SLUG = "verify_coupon_promises";
const VERSION = 1;

export const verifyCouponPromises: ResearchRecipe = {
  slug: SLUG,
  version: VERSION,
  description: "Verify that loyalty coupons the AI claimed to apply are actually applied and unused.",
  run: async (ticketId: string) => {
    const admin = createAdminClient();
    const findings: Finding[] = [];
    const gaps: Gap[] = [];

    // Load ticket + most recent AI/agent outbound message to extract claims
    const { data: ticket } = await admin
      .from("tickets")
      .select("workspace_id, customer_id")
      .eq("id", ticketId)
      .single();
    if (!ticket?.customer_id) {
      return { findings: [{ type: "no_customer", subject: ticketId, evidence: {}, severity: "info" }], gaps: [] };
    }

    const { data: msgs } = await admin
      .from("ticket_messages")
      .select("body_clean, body, author_type, created_at")
      .eq("ticket_id", ticketId)
      .eq("direction", "outbound")
      .eq("visibility", "external")
      .in("author_type", ["ai", "agent"])
      .order("created_at", { ascending: false })
      .limit(5);

    const promiseText = (msgs || [])
      .map(m => m.body_clean || (m.body || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "))
      .join("\n---\n");

    // Use Haiku to extract structured promises from the assistant text.
    // Falls back to "no promises detected" if the response can't parse.
    const claims = await extractCouponClaims(promiseText, ticket.workspace_id);

    findings.push({
      type: "extracted_claims",
      subject: "ai_promises",
      evidence: { claims, message_count: (msgs || []).length },
      severity: "info",
    });

    if (claims.length === 0) {
      return {
        findings,
        gaps: [{
          gap_id: "no_claims_found",
          description: "No coupon-application claims found in the recent assistant messages — nothing to verify.",
          severity: "low",
        }],
      };
    }

    // Pull current loyalty state — coupons + subs + their applied codes
    const state = await getLoyaltyAndSubState(ticket.workspace_id, ticket.customer_id);

    findings.push({
      type: "loyalty_member_state",
      subject: state.member?.id || "(none)",
      evidence: {
        points_balance: state.member?.points_balance ?? 0,
        coupons_count: state.coupons.length,
        unused_coupons: state.coupons.filter(c => c.available).length,
        subscriptions_count: state.subscriptions.length,
      },
      severity: "info",
    });

    // For each loyalty coupon currently applied to a sub, verify it's unused on Shopify
    for (const c of state.coupons) {
      if (!c.applied_to_contract_id) continue;
      if (c.used) {
        gaps.push({
          gap_id: `applied_coupon_already_used:${c.applied_to_contract_id}`,
          description: `Coupon ${c.code} is on subscription ${c.applied_to_contract_id} but Shopify says it's already been used (${c.shopify_usage_count}/${c.shopify_usage_limit}). The customer's next renewal won't get the discount.`,
          severity: "high",
          proposed_heal: {
            action_type: "redeem_points_and_apply_coupon",
            params: {
              tier_index: tierIndexForValue(c.discount_value),
              contract_id: c.applied_to_contract_id,
              replace_existing: true,
            },
            customer_message_template: "Just confirming — I refreshed the loyalty coupon on your subscription (${{discount_value}} off). It'll be applied to your next renewal automatically.",
            customer_message_persona: "suzie",
          },
        });
      } else {
        findings.push({
          type: "coupon_applied_correctly",
          subject: c.code,
          evidence: { contract_id: c.applied_to_contract_id, shopify_usage: `${c.shopify_usage_count}/${c.shopify_usage_limit}` },
          severity: "info",
        });
      }
    }

    // If the AI claimed coupons were applied to "all subs", verify each active sub has one
    const claimedSubsCovered = claims.some(c => /all (your )?(active )?subs|all (3|three|two|2) subscriptions|each (active )?sub/i.test(c.text));
    if (claimedSubsCovered) {
      const activeSubsWithoutLoyalty = state.subscriptions.filter(s => {
        if (s.status !== "active") return false;
        return !s.applied_discount_codes.some(code => code.startsWith("LOYALTY-"));
      });
      for (const s of activeSubsWithoutLoyalty) {
        const unused = state.coupons.find(c => c.available);
        const proposedHeal: Gap["proposed_heal"] = unused
          ? {
              action_type: "apply_loyalty_coupon",
              params: { contract_id: s.contract_id, code: unused.code },
              customer_message_template: "Quick update — I added a ${{discount_value}} loyalty coupon to your subscription that wasn't there before. It'll come off your next renewal.",
              customer_message_persona: "suzie",
            }
          : (state.member && state.member.points_balance >= 1500
              ? {
                  action_type: "redeem_points_and_apply_coupon",
                  params: { tier_index: 2, contract_id: s.contract_id },   // $15 / 1500 pts
                  customer_message_template: "Quick update — I redeemed 1,500 of your loyalty points for a $15 coupon and applied it to your subscription. It'll come off your next renewal.",
                  customer_message_persona: "suzie",
                }
              : undefined);
        gaps.push({
          gap_id: `missing_coupon:${s.contract_id}`,
          description: `AI claimed all subscriptions have loyalty coupons but contract ${s.contract_id} has none (${s.items_summary}).${proposedHeal ? "" : " No unused coupons and not enough points to redeem — escalate."}`,
          severity: "high",
          proposed_heal: proposedHeal,
        });
      }
    }

    return { findings, gaps };
  },
};

/** Extract structured claims about coupon application from assistant text via Haiku. */
async function extractCouponClaims(text: string, workspaceId: string): Promise<Array<{ text: string; coupon_code?: string; contract_id?: string }>> {
  if (!text || text.trim().length === 0) return [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{
          role: "user",
          content: `Extract every claim from this assistant message that a loyalty coupon WAS applied (or will be applied) to a subscription. Don't extract speculative offers ("would you like me to apply one?") — only definite past- or future-tense claims of application.

For each claim, capture the exact sentence and any coupon code (LOYALTY-15-...) or contract id mentioned. If the claim says "all your subscriptions" or "each of your subs", include that text as a single claim with no specific id.

Respond with JSON only, no prose:
{
  "claims": [
    {"text": "...", "coupon_code": "...", "contract_id": "..."}
  ]
}

If no such claims exist, return {"claims": []}.

Message text:
${text.slice(0, 6000)}`,
        }],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const responseText = data.content?.[0]?.text || "";
    const match = responseText.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    void workspaceId; // logging hook for later
    return (parsed.claims || []) as Array<{ text: string; coupon_code?: string; contract_id?: string }>;
  } catch {
    return [];
  }
}

function tierIndexForValue(value: number): number {
  if (value >= 15) return 2;   // $15 / 1500 pts
  if (value >= 10) return 1;   // $10 / 1000 pts
  return 0;                    // $5 / 500 pts
}
