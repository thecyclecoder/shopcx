/**
 * reactivate-journey-builder — the one-click win-back journey.
 *
 * Built for the Mixed Berry crisis win-back (CEO 2026-07-30): 187 customers cancelled while Mixed
 * Berry was out of stock. It's back, and we want them to restart with ONE CLICK from an email —
 * no login, no reply-to-inbox, no human in the loop.
 *
 * WHY A JOURNEY AND NOT "REPLY TO THIS EMAIL"
 * A reply lands in the ticket queue and needs Sol or a human to read it, work out which subscription
 * the customer meant, and fire the action. Across 187 customers that is 187 interpretations and 187
 * chances to get it wrong. A journey session is bound to ONE customer and ONE subscription at mint
 * time, so the click is unambiguous and the mutation is deterministic.
 *
 * HOW THE NO-LOGIN LINK WORKS
 * `journey_sessions.token` is a 48-char URL-safe secret ([[journey-tokens]] `generateJourneyToken`)
 * minted per customer and resolved at `/journey/{token}`. The session already carries `customer_id`
 * + `subscription_id`, so the link IS the authentication — the customer never signs in. Tokens carry
 * `token_expires_at`; a win-back link is long-lived by design (the offer is the point) but still
 * bounded.
 *
 * SHAPE
 * Single terminal step, single choice. Restarting a subscription is not a decision that benefits
 * from a funnel — every extra screen is a place to lose them. The confirm IS the conversion.
 *
 * The chosen value is executed SYNCHRONOUSLY by the single-step route
 * (`src/app/api/journey/[token]/step/route.ts`, `stepKey === "reactivate_choice"`), and the customer
 * sees the real result on the page:
 *   reactivate   → `reactivateSubscription` ([[subscription-reactivate]]), the same path as the
 *                  portal's Reactivate button: resume a paused sub, or revive a cancelled one on
 *                  ShopCX from our mirror at the customer's own price, first order tomorrow. A
 *                  missing card/address is reported honestly + noted on the ticket for follow-up.
 *   not_now      → recorded, no mutation — an honest opt-out beats a dead link
 *
 * 2026-11-21 fix: before this, the single-step journey only RECORDED the click (no outcome was
 * emitted, and the outcome handler keyed on a session.subscription_id the mint never set), so
 * "Yes, restart" never restarted anything.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { BuiltJourneyConfig } from "@/lib/journey-step-builder";

type Admin = ReturnType<typeof createAdminClient>;

function emptyConfig(): BuiltJourneyConfig {
  return { codeDriven: true, multiStep: false, steps: [] };
}

/**
 * Resolve the subscription this win-back should restart: the customer's most recent CANCELLED sub
 * (that is who we are emailing), else a paused one. Read across the whole linked-account group —
 * a customer whose cancelled sub sits on a sibling profile would otherwise get an empty journey.
 */
export async function resolveTargetSubscription(admin: Admin, workspaceId: string, customerId: string) {
  const { data: link } = await admin.from("customer_links")
    .select("group_id").eq("workspace_id", workspaceId).eq("customer_id", customerId).maybeSingle();
  let ids = [customerId];
  if (link?.group_id) {
    const { data: peers } = await admin.from("customer_links")
      .select("customer_id").eq("workspace_id", workspaceId).eq("group_id", link.group_id);
    ids = [...new Set([customerId, ...(peers || []).map((p) => p.customer_id as string)])];
  }
  const { data: subs } = await admin.from("subscriptions")
    .select("id, shopify_contract_id, status, items, updated_at")
    .eq("workspace_id", workspaceId).in("customer_id", ids)
    .in("status", ["cancelled", "paused"])
    .order("updated_at", { ascending: false });
  const paused = (subs || []).find((s) => s.status === "paused");
  return paused ?? (subs || [])[0] ?? null;
}

/** Human-readable item summary, e.g. "Superfood Tabs — Mixed Berry ×2". */
function describeItems(items: unknown): string {
  const list = (items as { title?: string; variant_title?: string; quantity?: number; sku?: string; price_cents?: number }[] | null) || [];
  const real = list.filter((i) => !String(i.sku ?? "").startsWith("insure") && Number(i.price_cents ?? 1) !== 0);
  if (!real.length) return "your subscription";
  return real
    .map((i) => `${i.title ?? i.sku ?? "item"}${i.variant_title ? ` — ${i.variant_title}` : ""}${(i.quantity ?? 1) > 1 ? ` ×${i.quantity}` : ""}`)
    .join(", ");
}

export async function buildReactivateSteps(
  admin: Admin, workspaceId: string, customerId: string, ticketId: string,
): Promise<BuiltJourneyConfig> {
  const sub = await resolveTargetSubscription(admin, workspaceId, customerId);
  if (!sub) return emptyConfig();

  const what = describeItems(sub.items);
  const wasPaused = sub.status === "paused";

  return {
    codeDriven: true,
    multiStep: false,
    steps: [{
      key: "reactivate_choice",
      type: "single_choice",
      question: wasPaused
        ? `Ready to restart your subscription? We'll pick it right back up with ${what}.`
        : `Want your subscription back? We'll restart it with ${what}.`,
      subtitle: "One click and you're set: same items, same price you had before. Your next order processes tomorrow.",
      options: [
        { value: "reactivate", label: "Yes, restart my subscription" },
        { value: "not_now", label: "Not right now" },
      ],
      isTerminal: true,
    }],
    metadata: {
      journeyType: "reactivate_subscription",
      subscriptionId: sub.id,
      contractId: sub.shopify_contract_id,
      previousStatus: sub.status,
      customerId,
      workspaceId,
      ticketId,
    },
  };
}
