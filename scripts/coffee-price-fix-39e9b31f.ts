/**
 * Ticket 39e9b31f: customer wanted 4× Amazing Coffee at $39.95/bag.
 * Qty was bumped to 4 but the price stayed at $53.29/bag. Update
 * the base price so customer pays $39.95/bag (base = 39.95 / 0.75 =
 * $53.27 with the existing 25% Subscribe & Save), then message the
 * customer + re-open the archived chat ticket.
 *
 * Contract: 27829436589  (Amazing Coffee — Cocoa French Roast)
 * Variant:  42614446260397
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
const TICKET_ID  = "39e9b31f-b247-4991-8052-a460468b0ab3";
const CONTRACT   = "27829436589";
const VARIANT    = "42614446260397";
const NEW_BASE_CENTS = 5327;  // $53.27 → customer pays $53.27 * 0.75 = $39.95 / bag

async function main() {
  console.log("Step 1: update line-item base price on Appstle…");
  const { subUpdateLineItemPrice } = await import("../src/lib/subscription-items");
  const r = await subUpdateLineItemPrice(WS, CONTRACT, VARIANT, NEW_BASE_CENTS);
  console.log("  →", r);
  if (!r.success) throw new Error(`price update failed: ${r.error}`);

  // Verify
  const { data: sub } = await admin.from("subscriptions")
    .select("items").eq("shopify_contract_id", CONTRACT).single();
  const item = (sub?.items as Array<{ variant_id?: string; quantity?: number; price_cents?: number; title?: string; variant_title?: string }> | undefined)
    ?.find(i => String(i.variant_id) === VARIANT);
  console.log("  items now:", item);

  console.log("\nStep 2: send chat reply + reopen ticket…");
  const body = `<p>All set — your next Amazing Coffee Cocoa French Roast order is now <strong>4 bags at $39.95 each</strong>. That'll bill on July 30 at the new pricing.</p><p>Let us know if you need anything else!</p><p>Julie at Superfoods Company</p>`;
  const { data: msg, error: insErr } = await admin.from("ticket_messages").insert({
    ticket_id: TICKET_ID,
    direction: "outbound",
    visibility: "external",
    author_type: "agent",
    body,
  }).select("id").single();
  if (insErr) throw insErr;

  await admin.from("tickets").update({
    status: "open",
    archived_at: null,
    closed_at: null,
    updated_at: new Date().toISOString(),
  }).eq("id", TICKET_ID);
  console.log(`  ✓ chat message queued ${msg?.id}, ticket reopened`);
}
main().catch(e => { console.error("✗", e); process.exit(1); });
