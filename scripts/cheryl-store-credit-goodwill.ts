/**
 * Cheryl Harrison (ticket 7d1c6ff3) — goodwill exception. Issue
 * $14.85 store credit ($4.95 × 3 to cover her last 3 orders'
 * shipping) and message her. NOT normal policy — Dylan flagged
 * this as a one-off because he likes her.
 *
 * Per customer-voice: no apology for the charges, no "let me know
 * if you don't see it," just confirm what we did with warmth.
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
const TICKET_ID  = "7d1c6ff3-bcc4-44b9-bdd8-36e8e276b0f5";
const CUSTOMER_ID = "dc6b6162-6d05-4a72-926e-8d606c8fb01f";
const SHOPIFY_CUSTOMER_ID = "7060062273709";
const AMOUNT = 14.85;  // $4.95 × 3
const ISSUED_BY = "496c3592-d105-4bf3-a3bb-1d2922405fb9";

async function main() {
  console.log(`Step 1: issue $${AMOUNT.toFixed(2)} store credit to Cheryl…`);
  const { issueStoreCredit } = await import("../src/lib/store-credit");
  const r = await issueStoreCredit({
    workspaceId: WS,
    customerId: CUSTOMER_ID,
    shopifyCustomerId: SHOPIFY_CUSTOMER_ID,
    amount: AMOUNT,
    reason: "Goodwill: covering shipping on last 3 orders (exception, not normal policy)",
    issuedBy: ISSUED_BY,
    issuedByName: "Julie",
    ticketId: TICKET_ID,
  });
  console.log("  →", r);
  if (!r.ok) throw new Error(`store credit failed: ${r.error}`);

  console.log("\nStep 2: queue customer reply…");
  const body = `<p>Hi Cheryl — we appreciate you so much. I've added <strong>$14.85 in store credit</strong> to your account (that's $4.95 × 3 to cover the shipping on your last three orders). The system will apply it automatically to your next order.</p>` +
    `<p>Thanks for being part of the Superfoods family.</p>` +
    `<p>Julie at Superfoods Company</p>`;

  // Thread off her latest inbound for clean Gmail threading.
  const { data: lastIn } = await admin
    .from("ticket_messages")
    .select("email_message_id")
    .eq("ticket_id", TICKET_ID).eq("direction", "inbound").eq("visibility", "external")
    .not("email_message_id", "is", null)
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const inReplyTo = lastIn?.email_message_id || null;

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
  if (inReplyTo) {
    await admin.from("tickets").update({
      email_message_id: inReplyTo,
      status: "open",
      updated_at: new Date().toISOString(),
    }).eq("id", TICKET_ID);
  } else {
    await admin.from("tickets").update({
      status: "open",
      updated_at: new Date().toISOString(),
    }).eq("id", TICKET_ID);
  }
  console.log(`  ✓ message queued ${msg?.id} threaded off ${inReplyTo || "(no prior msgid)"}`);

  console.log(`\n✓ Done. New store credit balance: $${r.balance.toFixed(2)}`);
}
main().catch(e => { console.error("✗", e); process.exit(1); });
