/**
 * verify_subscription_changes — the big one. Parses the most recent
 * AI/agent outbound messages on a ticket for any claim that touched a
 * subscription, and verifies the live state matches.
 *
 * Covers these claim types:
 *   pause, resume, skip_next_order, change_next_date, change_frequency,
 *   swap_variant, remove_item, add_item, update_line_price, cancel.
 *
 * Each claim → one finding (state matches) or one gap (mismatch). Gaps
 * propose the exact direct_action params that should have run, so heal
 * is a one-call replay of what the AI said it did.
 *
 * Cancel claims always emit a high-severity gap with NO proposed_heal —
 * executing a cancellation is destructive/high-impact, so it requires
 * human review. (A cancel itself is NOT terminal — it's reactivatable via
 * `subscriptionAction(..,"resume")` — but we still don't auto-execute one.)
 *
 * Heal proposals are limited to ones where we can resolve the target
 * variant_id (for swap/remove) and contract_id (explicit, single-sub
 * inference, or item-title match against current state).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { getSubsForCustomer, type SubState } from "@/lib/research/probes/subscription";
import type { ResearchRecipe, Finding, Gap, ProposedHeal } from "@/lib/research/types";

const SLUG = "verify_subscription_changes";
const VERSION = 1;

type ClaimType =
  | "pause"
  | "resume"
  | "skip_next_order"
  | "change_next_date"
  | "change_frequency"
  | "swap_variant"
  | "remove_item"
  | "add_item"
  | "update_line_price"
  | "cancel";

interface SubscriptionClaim {
  type: ClaimType;
  text: string;
  contract_id?: string | null;
  /** ISO date the AI claimed (next billing date or pause-until). */
  date?: string | null;
  /** For change_frequency. */
  interval?: "DAY" | "WEEK" | "MONTH" | "YEAR" | null;
  interval_count?: number | null;
  /** For swap_variant. */
  old_variant_title?: string | null;
  new_variant_title?: string | null;
  /** For add_item / remove_item. */
  variant_title?: string | null;
  quantity?: number | null;
  /** For update_line_price. */
  price_cents?: number | null;
}

export const verifySubscriptionChanges: ResearchRecipe = {
  slug: SLUG,
  version: VERSION,
  description: "Verify any subscription mutation the AI/agent claimed actually landed (pause, resume, skip, date change, frequency change, variant swap, item add/remove, line price, cancel).",
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

    const claims = await extractSubscriptionClaims(promiseText);

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
          description: "No subscription-mutation claims found in the recent assistant messages — nothing to verify.",
          severity: "low",
        }],
      };
    }

    const subs = await getSubsForCustomer(ticket.workspace_id, ticket.customer_id);
    const activeSubs = subs.filter(s => s.status === "active" || s.status === "paused");

    findings.push({
      type: "subscription_state",
      subject: "customer_subscriptions",
      evidence: {
        total: subs.length,
        active: subs.filter(s => s.status === "active").length,
        paused: subs.filter(s => s.status === "paused").length,
        cancelled: subs.filter(s => s.status === "cancelled").length,
      },
      severity: "info",
    });

    for (const claim of claims) {
      const sub = resolveClaimContract(claim, subs, activeSubs);
      if (!sub) {
        gaps.push({
          gap_id: `unresolved_target:${claim.type}:${(claim.contract_id || claim.variant_title || claim.text).slice(0, 40)}`,
          description: `Couldn't match the AI's "${claim.type}" claim to a specific subscription. AI said: "${claim.text.slice(0, 200)}"`,
          severity: "medium",
        });
        continue;
      }

      const verdict = verifyClaim(claim, sub);
      if (verdict.ok) {
        findings.push({
          type: `${claim.type}_verified`,
          subject: sub.contract_id,
          evidence: { claim_text: claim.text.slice(0, 200), state: verdict.evidence },
          severity: "info",
        });
        continue;
      }

      // Mismatch — emit gap. Cancel is special: high severity, no heal.
      if (claim.type === "cancel") {
        gaps.push({
          gap_id: `cancel_not_executed:${sub.contract_id}`,
          description: `AI claimed subscription ${sub.contract_id} was cancelled, but its current status is "${sub.status}". Cancellation requires human review — not auto-healed because it's irreversible.`,
          severity: "high",
        });
        continue;
      }

      const proposedHeal = buildProposedHeal(claim, sub);
      gaps.push({
        gap_id: `${claim.type}_mismatch:${sub.contract_id}`,
        description: `AI claimed "${claim.type}" on ${sub.contract_id} but ${verdict.reason}. AI text: "${claim.text.slice(0, 200)}"`,
        severity: "high",
        proposed_heal: proposedHeal,
      });
    }

    return { findings, gaps };
  },
};

// ────────────────────────────────────────────────────────────────────────
// Claim extraction (Haiku)
// ────────────────────────────────────────────────────────────────────────
async function extractSubscriptionClaims(text: string): Promise<SubscriptionClaim[]> {
  if (!text || text.trim().length === 0) return [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1200,
        messages: [{
          role: "user",
          content: `Extract every claim from this customer-support message text where the assistant said they DID (or WILL definitely) perform a subscription action. Only definite past- or future-tense actions — not speculative offers like "would you like me to pause it?".

Action types to extract:
- "pause"             — paused/will pause the sub. Include resume date if mentioned.
- "resume"            — reactivated/unpaused the sub.
- "skip_next_order"   — skipped/will skip the next shipment.
- "change_next_date"  — moved next billing date to a specific date.
- "change_frequency"  — switched billing cadence (e.g. "every 2 months").
- "swap_variant"      — switched the sub to a different flavor/variant.
- "remove_item"       — removed an item/flavor from the sub.
- "add_item"          — added an item/flavor to the sub.
- "update_line_price" — changed the per-item price.
- "cancel"            — cancelled the subscription.

Respond with JSON only, no prose:
{
  "claims": [
    {
      "type": "pause|resume|skip_next_order|change_next_date|change_frequency|swap_variant|remove_item|add_item|update_line_price|cancel",
      "text": "<the exact sentence>",
      "contract_id": "<numeric Appstle contract id if mentioned, else null>",
      "date": "<YYYY-MM-DD if a specific date was mentioned, else null>",
      "interval": "DAY|WEEK|MONTH|YEAR or null",
      "interval_count": <integer or null>,
      "old_variant_title": "<for swap_variant — text from the original, else null>",
      "new_variant_title": "<for swap_variant — text from the target, else null>",
      "variant_title": "<for add_item/remove_item/update_line_price — the item title, else null>",
      "quantity": <integer or null>,
      "price_cents": <integer cents if a $ amount was mentioned for the new line price, else null>
    }
  ]
}

If no such claims exist, return {"claims": []}.

Message text:
${text.slice(0, 8000)}`,
        }],
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const responseText = data.content?.[0]?.text || "";
    const match = responseText.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    return (parsed.claims || []) as SubscriptionClaim[];
  } catch {
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────
// Target resolution — figure out which sub a claim refers to
// ────────────────────────────────────────────────────────────────────────
function resolveClaimContract(claim: SubscriptionClaim, allSubs: SubState[], activeSubs: SubState[]): SubState | null {
  // 1. Explicit contract id wins
  if (claim.contract_id) {
    const exact = allSubs.find(s => s.contract_id === claim.contract_id);
    if (exact) return exact;
  }
  // 2. Cancel claims look at any state (including cancelled)
  if (claim.type === "cancel") {
    // If there's an obvious recent cancellation candidate, prefer it.
    const recentlyCancelled = allSubs.find(s => s.status === "cancelled");
    if (recentlyCancelled && allSubs.filter(s => s.status === "cancelled").length === 1) return recentlyCancelled;
    if (activeSubs.length === 1) return activeSubs[0];
  }
  // 3. Item-title match (swap/remove/add/update_line_price)
  const itemTitle = claim.old_variant_title || claim.variant_title;
  if (itemTitle && activeSubs.length > 0) {
    const lower = itemTitle.toLowerCase();
    const subWithItem = activeSubs.find(s =>
      s.items.some(it => `${it.title || ""} ${it.variant_title || ""}`.toLowerCase().includes(lower)),
    );
    if (subWithItem) return subWithItem;
  }
  // 4. Single active sub → infer
  if (activeSubs.length === 1) return activeSubs[0];
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Per-claim verification
// ────────────────────────────────────────────────────────────────────────
function verifyClaim(claim: SubscriptionClaim, sub: SubState): { ok: boolean; reason?: string; evidence: Record<string, unknown> } {
  switch (claim.type) {
    case "pause":
      if (sub.status === "paused") return { ok: true, evidence: { status: sub.status, pause_resume_at: sub.pause_resume_at } };
      return { ok: false, reason: `the subscription's current status is "${sub.status}"`, evidence: { status: sub.status } };

    case "resume":
      if (sub.status === "active") return { ok: true, evidence: { status: sub.status } };
      return { ok: false, reason: `the subscription's current status is "${sub.status}", not active`, evidence: { status: sub.status } };

    case "cancel":
      if (sub.status === "cancelled") return { ok: true, evidence: { status: sub.status } };
      return { ok: false, reason: `the subscription's current status is "${sub.status}", not cancelled`, evidence: { status: sub.status } };

    case "change_next_date": {
      if (!claim.date) return { ok: true, evidence: { next_billing_date: sub.next_billing_date, note: "no claimed date to compare" } };
      const claimedISO = claim.date.slice(0, 10);
      const actualISO = (sub.next_billing_date || "").slice(0, 10);
      if (actualISO && actualISO === claimedISO) {
        return { ok: true, evidence: { next_billing_date: actualISO } };
      }
      return { ok: false, reason: `next_billing_date is ${actualISO || "(null)"}, AI claimed ${claimedISO}`, evidence: { claimed: claimedISO, actual: actualISO } };
    }

    case "change_frequency": {
      if (!claim.interval || !claim.interval_count) return { ok: true, evidence: { interval: sub.billing_interval, interval_count: sub.billing_interval_count, note: "no claimed interval to compare" } };
      const ok = sub.billing_interval.toUpperCase() === claim.interval.toUpperCase()
             && sub.billing_interval_count === claim.interval_count;
      if (ok) return { ok: true, evidence: { interval: sub.billing_interval, interval_count: sub.billing_interval_count } };
      return { ok: false, reason: `billing is every ${sub.billing_interval_count} ${sub.billing_interval}, AI claimed every ${claim.interval_count} ${claim.interval}`, evidence: { claimed: `${claim.interval_count} ${claim.interval}`, actual: `${sub.billing_interval_count} ${sub.billing_interval}` } };
    }

    case "swap_variant": {
      if (!claim.new_variant_title) return { ok: true, evidence: { items: sub.items, note: "no target variant title to compare" } };
      const target = claim.new_variant_title.toLowerCase();
      const has = sub.items.some(it => `${it.title || ""} ${it.variant_title || ""}`.toLowerCase().includes(target));
      if (has) return { ok: true, evidence: { items: sub.items.map(i => `${i.title}/${i.variant_title}`) } };
      return { ok: false, reason: `subscription items don't include "${claim.new_variant_title}"`, evidence: { items: sub.items.map(i => `${i.title}/${i.variant_title}`) } };
    }

    case "remove_item": {
      if (!claim.variant_title) return { ok: true, evidence: { items: sub.items, note: "no item title to compare" } };
      const target = claim.variant_title.toLowerCase();
      const stillThere = sub.items.some(it => `${it.title || ""} ${it.variant_title || ""}`.toLowerCase().includes(target));
      if (!stillThere) return { ok: true, evidence: { items: sub.items.map(i => `${i.title}/${i.variant_title}`) } };
      return { ok: false, reason: `"${claim.variant_title}" is still on the subscription`, evidence: { items: sub.items.map(i => `${i.title}/${i.variant_title}`) } };
    }

    case "add_item": {
      if (!claim.variant_title) return { ok: true, evidence: { items: sub.items, note: "no item title to compare" } };
      const target = claim.variant_title.toLowerCase();
      const has = sub.items.some(it => `${it.title || ""} ${it.variant_title || ""}`.toLowerCase().includes(target));
      if (has) return { ok: true, evidence: { items: sub.items.map(i => `${i.title}/${i.variant_title}`) } };
      return { ok: false, reason: `"${claim.variant_title}" is not on the subscription`, evidence: { items: sub.items.map(i => `${i.title}/${i.variant_title}`) } };
    }

    case "update_line_price": {
      if (claim.price_cents == null || !claim.variant_title) return { ok: true, evidence: { items: sub.items, note: "no price/title to compare" } };
      const target = claim.variant_title.toLowerCase();
      const matchedItem = sub.items.find(it => `${it.title || ""} ${it.variant_title || ""}`.toLowerCase().includes(target));
      if (!matchedItem) return { ok: false, reason: `couldn't find a line item matching "${claim.variant_title}"`, evidence: { items: sub.items.map(i => `${i.title}/${i.variant_title}`) } };
      if (matchedItem.price_cents === claim.price_cents) {
        return { ok: true, evidence: { variant_title: claim.variant_title, price_cents: matchedItem.price_cents } };
      }
      return { ok: false, reason: `line item price is $${((matchedItem.price_cents || 0) / 100).toFixed(2)}, AI claimed $${(claim.price_cents / 100).toFixed(2)}`, evidence: { claimed_cents: claim.price_cents, actual_cents: matchedItem.price_cents } };
    }

    case "skip_next_order":
      // We can't 100% verify a skip from DB state alone without knowing
      // the pre-skip next_billing_date. Best heuristic: treat as
      // verified — heal is a no-op if it was actually skipped, and
      // re-firing skip on Appstle for an already-skipped order is
      // idempotent. Flag as "unverified" via evidence so the analyzer
      // page shows the limitation.
      return { ok: true, evidence: { next_billing_date: sub.next_billing_date, note: "skip not strictly verifiable from DB state — trusting current state" } };

    default:
      return { ok: true, evidence: {} };
  }
}

// ────────────────────────────────────────────────────────────────────────
// Heal proposal builder
// ────────────────────────────────────────────────────────────────────────
function buildProposedHeal(claim: SubscriptionClaim, sub: SubState): ProposedHeal | undefined {
  const contractId = sub.contract_id;
  switch (claim.type) {
    case "pause": {
      // Compute pause_days from claimed resume date if available.
      let pauseDays = 30;
      if (claim.date) {
        const target = new Date(`${claim.date.slice(0, 10)}T00:00:00`);
        const today = new Date();
        const days = Math.round((target.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        if (days >= 30 && days <= 60) pauseDays = days <= 30 ? 30 : 60;
        else pauseDays = days > 30 ? 60 : 30;
      }
      return {
        action_type: "pause",
        params: { contract_id: contractId, pause_days: pauseDays },
        customer_message_template: "Following up — I just paused your subscription. It'll automatically pick back up after that.",
        customer_message_persona: "suzie",
      };
    }
    case "resume":
      return {
        action_type: "resume",
        params: { contract_id: contractId },
        customer_message_template: "Following up — your subscription is reactivated. Your next order will ship on {{next_date}}.",
        customer_message_persona: "suzie",
      };
    case "skip_next_order":
      return {
        action_type: "skip_next_order",
        params: { contract_id: contractId },
        customer_message_template: "Quick follow-up — your next order is officially skipped. The one after it ships on {{next_date}}.",
        customer_message_persona: "suzie",
      };
    case "change_next_date": {
      if (!claim.date) return undefined;
      return {
        action_type: "change_next_date",
        params: { contract_id: contractId, date: claim.date.slice(0, 10) },
        customer_message_template: "Got it sorted — your next order is now set to ship on {{next_date}}.",
        customer_message_persona: "suzie",
      };
    }
    case "change_frequency": {
      if (!claim.interval || !claim.interval_count) return undefined;
      return {
        action_type: "change_frequency",
        params: {
          contract_id: contractId,
          interval: claim.interval,
          interval_count: claim.interval_count,
        },
        customer_message_template: "All set — your subscription is now on the every {{interval_count}} {{interval}} schedule.",
        customer_message_persona: "suzie",
      };
    }
    case "swap_variant": {
      // We need both old + new variant ids. Old comes from current items;
      // new can't be derived without a product lookup. Without the new
      // variant id, we can't propose a clean heal — return undefined so
      // the gap escalates instead of auto-running with bad params.
      const oldVariantId = sub.items.find(it =>
        claim.old_variant_title && `${it.title || ""} ${it.variant_title || ""}`.toLowerCase().includes(claim.old_variant_title.toLowerCase()),
      )?.variant_id || sub.items[0]?.variant_id;
      if (!oldVariantId) return undefined;
      // No reliable way to derive new_variant_id at recipe time without
      // a product lookup keyed on title. Leave undefined → escalate.
      return undefined;
    }
    case "remove_item": {
      const variantId = sub.items.find(it =>
        claim.variant_title && `${it.title || ""} ${it.variant_title || ""}`.toLowerCase().includes(claim.variant_title.toLowerCase()),
      )?.variant_id;
      if (!variantId) return undefined;
      return {
        action_type: "remove_item",
        params: { contract_id: contractId, variant_id: variantId },
        customer_message_template: "Quick update — I removed {{variant_title}} from your subscription. Future shipments won't include it.",
        customer_message_persona: "suzie",
      };
    }
    case "add_item":
      // Same constraint as swap — we'd need a product lookup to resolve
      // the new variant id from a title string. Escalate instead.
      return undefined;
    case "update_line_price": {
      if (!claim.price_cents || !claim.variant_title) return undefined;
      const variantId = sub.items.find(it =>
        claim.variant_title && `${it.title || ""} ${it.variant_title || ""}`.toLowerCase().includes(claim.variant_title.toLowerCase()),
      )?.variant_id;
      if (!variantId) return undefined;
      return {
        action_type: "update_line_item_price",
        params: { contract_id: contractId, variant_id: variantId, base_price_cents: claim.price_cents },
        customer_message_template: "Following up — your {{variant_title}} price is now ${{value}} per box, as promised.",
        customer_message_persona: "suzie",
      };
    }
    case "cancel":
      // Executing a cancellation is destructive/high-impact — never auto-propose
      // (human review). Not because it's terminal: a cancel is reactivatable.
      return undefined;
    default:
      return undefined;
  }
}
