/**
 * Catherine Green (7f215e32) — her Superfood Tabs kept shipping to the OLD
 * Rochester MN address instead of her Kirkland WA address (verified correct on
 * her account default + addresses[] + active subscription). Create a free
 * replacement to Kirkland with an EXPLICIT address override (priority-1, so it
 * bypasses the order-address fallback that copied Rochester), matching SC134025
 * (1x Superfood Tabs, variant 42614433480877), then message her via the
 * canonical delivery path. Idempotency-guarded. Dylan-directed, 2026-07-07.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { createReplacementOrder } from "../src/lib/replacement-order";
import { deliverTicketMessage } from "../src/lib/ticket-delivery";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CUST = "7f215e32-a825-4a55-b558-9630dd2357c9";
const TID = "49ddd6c4-9894-4474-b925-fffe19a175c8";
const KIRKLAND = {
  firstName: "Catherine", lastName: "Green",
  address1: "9109 125th Ave NE", address2: "",
  city: "Kirkland", province: "Washington", provinceCode: "WA",
  zip: "98033", countryCode: "US",
};

async function main() {
  const db = createAdminClient();

  // Idempotency guard — don't double-ship if this already ran.
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: recent } = await db.from("replacements")
    .select("id, created_at, validated_address, shopify_order_name")
    .eq("customer_id", CUST)
    .gte("created_at", since);
  const dup = (recent || []).find((r) => {
    const a = (r as any).validated_address as { city?: string } | null;
    return a?.city?.toLowerCase() === "kirkland";
  });
  if (dup) {
    console.log("GUARD: a Kirkland replacement already exists in the last 24h:", (dup as any).shopify_order_name, (dup as any).id, "— aborting to avoid a duplicate.");
    process.exit(0);
  }

  const { data: cust } = await db.from("customers").select("shopify_customer_id, email").eq("id", CUST).single();
  if (!cust?.shopify_customer_id) { console.log("no shopify_customer_id — abort"); process.exit(1); }

  console.log("Creating replacement → Kirkland WA 98033 (1x Superfood Tabs, variant 42614433480877)…");
  const r = await createReplacementOrder({
    workspaceId: WS,
    customerId: CUST,
    shopifyCustomerId: cust.shopify_customer_id,
    items: [{ variantId: "42614433480877", quantity: 1, title: "Superfood Tabs" }],
    shippingAddress: KIRKLAND,
    reason: "wrong_address",
    originalOrderNumber: "SC134025",
    subscriptionId: null,
    ticketId: TID,
    customerError: false, // OUR system pulled the stale address, not her mistake
    shopifyNote: "Replacement — order kept shipping to old Rochester address; correcting to customer's Kirkland address. Human-directed.",
    initiatedBy: "agent",
    initiatedByName: "Dylan",
  });

  if (!r.success) { console.error("REPLACEMENT FAILED:", r.error); process.exit(1); }
  console.log("Replacement created:", r.shopifyOrderName || "(no name)", "replacementId:", r.replacementId);

  // Internal audit note on the ticket.
  await db.from("ticket_messages").insert({
    ticket_id: TID,
    direction: "outbound",
    visibility: "internal",
    author_type: "agent",
    body: `[System] Human-directed replacement ${r.shopifyOrderName || ""} created → 9109 125th Ave NE, Kirkland WA 98033 (explicit override; root cause: SC134025 + fallback pulled stale Rochester MN address). Free, 1x Superfood Tabs.`,
  });

  // Customer-facing reply — plain text, ≤2 sentences/paragraph, backed claims only.
  const message = [
    "Catherine, you're right — the order kept routing to the old Rochester address instead of your Kirkland one. I've just sent a fresh replacement of your Superfood Tabs to 9109 125th Ave NE, Kirkland WA 98033, at no charge.",
    "You don't need to do anything else to receive it. We're also correcting why it kept defaulting to the old address so your future orders ship to Kirkland.",
    "Suzie, Customer Support at Superfoods Company",
  ].join("\n\n");

  console.log("Delivering message to", cust.email, "…");
  await deliverTicketMessage(db, WS, TID, "email", message, false);
  console.log("DONE — replacement shipped to Kirkland + customer emailed.");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
