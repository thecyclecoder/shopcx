/**
 * Samantha Dawson (ticket ec209c7c) — asked to "exchange" current
 * creamer for Cinnamon Roll. We don't do exchanges on shipped
 * orders. We DO offer subscription variant swaps for the next
 * renewal. This script:
 *
 *   1. Adds a workspace `policies` row (slug='no_exchanges')
 *   2. Adds a `sonnet_prompts` rule so the AI handles future
 *      exchange asks the same way (offer the sub-swap path, no
 *      apologies, no negative framing)
 *   3. Swaps her creamer line item Vanilla → Cinnamon Roll on
 *      her active sub (contract 33787314349)
 *   4. Messages her confirming the swap — no hedge, no "if you
 *      don't like it, reply to pause" bait. Just confirm.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS         = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET_ID  = "ec209c7c-fdac-453c-8629-0a76ba8fd358";
const CUSTOMER_ID = "6241340a-0175-491c-93d2-16d0090ebe95";
const CONTRACT   = "33787314349";
const VANILLA_CREAMER       = "42618626867373";
const CINNAMON_ROLL_CREAMER = "43512521523373";

const POLICY_CUSTOMER = "We don't offer exchanges on past orders. If you're on a subscription, we can swap your next renewal's flavor or variant — just let us know what you'd like instead.";
const POLICY_INTERNAL = "No exchanges on shipped orders. The closest path is a subscription line-item swap that applies to the NEXT renewal only — never retroactively to the order already shipped. Don't promise refund-and-reship: that's exchange semantics we don't support. When a customer with an active sub asks for an exchange, swap the variant on the sub immediately and frame it as 'next shipment will have X.' When a customer WITHOUT an active sub asks, decline the exchange — no path.";

const SONNET_RULE_CONTENT = `EXCHANGES — when a customer asks to exchange a product (already shipped or about to ship):

We do NOT exchange shipped orders. There is no refund-and-reship path; never offer it.

What we CAN do, in this order:
  1. If they have an active subscription containing the same product type, swap the subscription line item to the new variant they want. The change applies to the NEXT renewal — say so explicitly ("your next shipment will be X"). Use the swap_variant direct action.
  2. If no active subscription exists, decline cleanly. Don't apologize at length. State the policy briefly and link to the policy page (policies.slug='no_exchanges' has the customer-facing copy).

Tone:
  - Don't apologize for the policy or for the customer's situation. State what we CAN do.
  - Don't bait a negative outcome. Never write "if you don't like it, reply to pause" — that primes a return path before they've tried it. Assume the best.
  - Don't reframe as "credit toward next order" or "store credit on the exchange" — those aren't policies we have.

The published customer-facing policy lives at workspaces.policies where slug='no_exchanges'.`;

async function main() {
  // ── 1. Policy row ────────────────────────────────────────────────
  console.log("Step 1: insert/upsert policies row for 'no_exchanges'…");
  const { data: existingPolicy } = await admin.from("policies")
    .select("id").eq("workspace_id", WS).eq("slug", "no_exchanges")
    .eq("is_active", true).maybeSingle();
  if (existingPolicy) {
    console.log(`  policy already exists (${existingPolicy.id}); skipping insert`);
  } else {
    const { error: polErr } = await admin.from("policies").insert({
      workspace_id: WS,
      slug: "no_exchanges",
      name: "No Exchanges",
      version: 1,
      customer_summary: POLICY_CUSTOMER,
      internal_summary: POLICY_INTERNAL,
      rules: [
        { condition: "customer_has_active_subscription", action: "offer_subscription_variant_swap_for_next_renewal" },
        { condition: "customer_has_no_active_subscription", action: "decline_no_exchange_path" },
        { invariant: "never_refund_and_reship" },
      ],
      is_active: true,
    });
    if (polErr) throw polErr;
    console.log(`  ✓ policy inserted`);
  }

  // ── 2. Sonnet rule ───────────────────────────────────────────────
  console.log("\nStep 2: insert sonnet_prompts rule…");
  const { data: existingRule } = await admin.from("sonnet_prompts")
    .select("id").eq("workspace_id", WS).eq("title", "rule_no_exchanges").maybeSingle();
  if (existingRule) {
    console.log(`  rule already exists (${existingRule.id}); skipping insert`);
  } else {
    const { error: ruleErr } = await admin.from("sonnet_prompts").insert({
      workspace_id: WS,
      title: "rule_no_exchanges",
      category: "rule",
      content: SONNET_RULE_CONTENT,
      enabled: true,
      status: "approved",
      derived_from_ticket_id: TICKET_ID,
    });
    if (ruleErr) throw ruleErr;
    console.log(`  ✓ sonnet_prompts rule inserted`);
  }

  // ── 3. Swap creamer Vanilla → Cinnamon Roll ──────────────────────
  console.log("\nStep 3: swap creamer Vanilla → Cinnamon Roll on contract", CONTRACT);
  const { directActionHandlers } = await import("../src/lib/action-executor");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = {
    admin, workspaceId: WS, ticketId: TICKET_ID, customerId: CUSTOMER_ID,
    channel: "email", sandbox: false,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const swap = await directActionHandlers.swap_variant(ctx, {
    type: "swap_variant",
    contract_id: CONTRACT,
    old_variant_id: VANILLA_CREAMER,
    new_variant_id: CINNAMON_ROLL_CREAMER,
    quantity: 1,
  } as any);
  console.log("  →", swap);
  if (!swap.success) throw new Error(`swap failed: ${swap.error}`);

  // ── 4. Reply on the ticket ───────────────────────────────────────
  console.log("\nStep 4: queue confirmation reply…");
  const body = `<p>Hi Samantha — thanks for reaching out! We're not able to swap a product that's already shipped, but I've updated your subscription so your next renewal will be Amazing Creamer in <strong>Cinnamon Roll</strong> instead of Vanilla.</p>` +
    `<p>Your coffee stays as Cocoa French Roast. Enjoy the new flavor!</p>` +
    `<p>Julie at Superfoods Company</p>`;
  const pendingAt = new Date(Date.now() + 5_000).toISOString();
  const { data: msg, error: insErr } = await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID,
    direction: "outbound",
    visibility: "external",
    author_type: "agent",
    body,
    pending_send_at: pendingAt,
  }).select("id").single();
  if (insErr) throw insErr;
  await admin.from("tickets").update({
    status: "open",
    updated_at: new Date().toISOString(),
  }).eq("id", TICKET_ID);
  console.log(`  ✓ message queued ${msg?.id} for ${pendingAt}`);

  console.log("\n✓ All done.");
  console.log("  • Policy 'no_exchanges' active in workspace");
  console.log("  • Sonnet rule 'rule_no_exchanges' enabled");
  console.log("  • Subscription creamer line: Vanilla → Cinnamon Roll");
  console.log("  • Customer message queued");
}
main().catch(e => { console.error("✗", e); process.exit(1); });
