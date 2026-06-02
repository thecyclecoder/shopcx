/**
 * Angelyna Reggiani (ticket 0428c8a9). Customer received the
 * Peach Mango Superfood Tabs swap on SC131688 and reports the
 * tablets are discolored + stuck together — she's afraid to use
 * them. The Replacement playbook kept loop-failing because the
 * Missing/Damaged Items journey treats "all items present" as
 * "nothing wrong" — there was no option for "received but
 * unusable" (heat damage, etc.).
 *
 * Manual remediation:
 *   1. Create a $0 replacement order for 1× SC-TABS-PM-2 (Peach
 *      Mango Superfood Tabs) shipping to her on-file address
 *   2. Message her about the replacement + flag heat as a likely
 *      culprit (the user's hypothesis — she's in NJ in early June,
 *      package may have sat in a hot truck/box)
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TICKET_ID = "0428c8a9-5bed-46b1-a91d-fbd70525b025";
const CUSTOMER_ID = "ea38e028-000f-41f6-a789-335d2551262c";
const ORDER_NUMBER = "SC131688";
const PEACH_MANGO_VARIANT = "42614433513645"; // SC-TABS-PM-2

async function main() {
  const { directActionHandlers } = await import("../src/lib/action-executor");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx: any = {
    admin, workspaceId: WS, ticketId: TICKET_ID, customerId: CUSTOMER_ID,
    channel: "email", sandbox: false,
  };

  console.log("Step 1: create replacement order — 1× Peach Mango Superfood Tabs");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const repl = await directActionHandlers.create_replacement_order(ctx, {
    type: "create_replacement_order",
    order_number: ORDER_NUMBER,
    variant_id: PEACH_MANGO_VARIANT,
    quantity: 1,
    reason: "damaged_items",
  } as any);
  console.log("  →", repl);
  if (!repl.success) throw new Error(`replacement failed: ${repl.error}`);

  console.log("\nStep 2: message Angelyna");
  const body = `<p>Hi Angelyna — I'm so sorry about the tablets that arrived discolored and stuck together. That should not happen. I've issued you a free replacement bag of Peach Mango Superfood Tabs and it'll ship out today — you'll get a tracking email once it's on its way.</p><p>One thing that may have caused this: if the package sat in a hot truck or on the doorstep in direct sun for a while before you brought it inside, the tablets can soften and clump together. Now that the warmer months are starting, that's something to watch for going forward.</p><p>Once your replacement arrives, the tablets should look like the good batch in your photo. If anything looks off again, just reply here and I'll take care of it right away.</p><p>Suzie, Customer Support at Superfoods Company</p>`;
  const pendingAt = new Date(Date.now() + 5_000).toISOString();
  const { data: msg } = await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID, direction: "outbound", visibility: "external",
    author_type: "agent", body, pending_send_at: pendingAt,
  }).select("id").single();
  await admin.from("tickets").update({
    status: "open", escalated: false, escalation_reason: null,
    updated_at: new Date().toISOString(),
  }).eq("id", TICKET_ID);
  console.log(`  ✓ queued message ${msg?.id} for ${pendingAt}`);
}
main().catch(e => { console.error("✗", e); process.exit(1); });
