/**
 * Ticket d31f8183 — Brad Karnowski (sftl87@yahoo.com).
 * Dylan offered (and Brad accepted) a restarted 3-bag Amazing Coffee
 * subscription at $44.95/bag realized. Per Dylan's directive:
 *   - restart cancelled contract 29952737453
 *   - strip it to JUST 3 bags of Amazing Coffee (2 Hazelnut + 1 Cocoa)
 *   - remove the stacking 12% "Buy 3 Discount" so the ONLY discount is the
 *     25% Subscribe & Save
 *   - use the pricing-policy heal step: basePrice $59.93 + 25% cycle discount
 *     → realized $44.95/bag (59.93 * 0.75 = 44.9475 ≈ 44.95)
 *
 * This script does the SUBSCRIPTION EDITS + VERIFY only. Billing ("order now")
 * is a separate script run after this verifies clean.
 *
 * Contract:  29952737453 (sub row 356d0096-6373-49a1-bcad-9799908b706c)
 * Keep:      Amazing Coffee Hazelnut French Roast — variant 42614446325933 (qty 2)
 * Add:       Amazing Coffee Cocoa French Roast    — variant 42614446260397 (qty 1)
 * Remove:    ACV Gummies — variant 42618781302957
 *            Shipping Protection — variant 42898153898157
 * Remove discount: gid://shopify/SubscriptionManualDiscount/5a4dba9b-458c-4df4-bffe-4c5eb116f520 (12%)
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
import { decrypt } from "../src/lib/crypto";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const C = "29952737453";
const SUB_ID = "356d0096-6373-49a1-bcad-9799908b706c";
const HAZELNUT = "42614446325933";
const COCOA = "42614446260397";
const ACV_GUMMIES = "42618781302957";
const SHIPPING_PROT = "42898153898157";
const DISCOUNT_ID = "gid://shopify/SubscriptionManualDiscount/5a4dba9b-458c-4df4-bffe-4c5eb116f520";
const BASE_PRICE = "59.93"; // 44.95 / 0.75 = 59.9333 → 59.93 → *0.75 = 44.9475 ≈ 44.95
const SNS_PCT = 25;

const APPSTLE = "https://subscription-admin.appstle.com/api/external/v2";
let API_KEY = "";

async function fetchContract(): Promise<Record<string, unknown>> {
  const res = await fetch(`${APPSTLE}/subscription-contracts/contract-external/${C}?api_key=${API_KEY}`,
    { headers: { "X-API-Key": API_KEY }, cache: "no-store" });
  if (!res.ok) throw new Error(`contract fetch ${res.status}`);
  return res.json();
}
function lineGid(contract: Record<string, unknown>, variant: string): string | null {
  const lines = ((contract.lines as Record<string, unknown>)?.nodes || []) as Record<string, unknown>[];
  const m = lines.find(l => String(l.variantId).split("/").pop() === variant);
  return m ? String(m.id) : null;
}
function summarize(contract: Record<string, unknown>) {
  const lines = ((contract.lines as Record<string, unknown>)?.nodes || []) as Record<string, unknown>[];
  for (const l of lines) {
    const pp = l.pricingPolicy as Record<string, unknown> | null;
    const base = pp ? (pp.basePrice as Record<string, unknown>)?.amount : null;
    console.log(`    • ${l.title} / ${l.variantTitle ?? ""} qty ${l.quantity} | current $${(l.currentPrice as Record<string, unknown>)?.amount} | base ${base ?? "(none)"} | discounted $${(l.lineDiscountedPrice as Record<string, unknown>)?.amount}`);
  }
  const discs = ((contract.discounts as Record<string, unknown>)?.nodes || []) as Record<string, unknown>[];
  console.log(`    discounts: ${discs.length ? discs.map(d => `${d.title}(${JSON.stringify(d.value)})`).join(", ") : "none"}`);
  console.log(`    status: ${contract.status} | nextBilling: ${contract.nextBillingDate}`);
}

async function main() {
  const { data: ws } = await admin.from("workspaces").select("appstle_api_key_encrypted").eq("id", WS).single();
  API_KEY = decrypt(ws!.appstle_api_key_encrypted as string);

  const { subAddItem, subRemoveItem } = await import("../src/lib/subscription-items");
  const { appstleSubscriptionAction } = await import("../src/lib/appstle");

  console.log("BEFORE:"); summarize(await fetchContract());

  // 1) Resume (un-cancel) the contract
  console.log("\n[1] resume contract → ACTIVE");
  const r1 = await appstleSubscriptionAction(WS, C, "resume");
  if (!r1.success) throw new Error(`resume failed: ${r1.error}`);
  console.log("    ✓ resumed");

  // 2) Remove the stacking 12% "Buy 3 Discount"
  console.log("\n[2] remove 12% Buy 3 Discount");
  const dRes = await fetch(`${APPSTLE}/subscription-contracts-remove-discount?contractId=${C}&discountId=${encodeURIComponent(DISCOUNT_ID)}`,
    { method: "PUT", headers: { "X-API-Key": API_KEY } });
  if (!dRes.ok && dRes.status !== 204) throw new Error(`remove-discount ${dRes.status}: ${await dRes.text()}`);
  console.log(`    ✓ remove-discount HTTP ${dRes.status}`);

  // 3) Remove ACV Gummies
  console.log("\n[3] remove ACV Gummies");
  const r3 = await subRemoveItem(WS, C, ACV_GUMMIES);
  if (!r3.success) throw new Error(`remove gummies failed: ${r3.error}`);
  console.log("    ✓ removed");

  // 4) Remove Shipping Protection
  console.log("\n[4] remove Shipping Protection");
  const r4 = await subRemoveItem(WS, C, SHIPPING_PROT);
  if (!r4.success) throw new Error(`remove shipping protection failed: ${r4.error}`);
  console.log("    ✓ removed");

  // 5) Add Cocoa French Roast x1
  console.log("\n[5] add Cocoa French Roast x1");
  const r5 = await subAddItem(WS, C, COCOA, 1);
  if (!r5.success) throw new Error(`add cocoa failed: ${r5.error}`);
  console.log("    ✓ added");

  // 6) Pricing-policy heal step on both coffee lines: base $59.93 + 25% cycle
  console.log("\n[6] write pricing policy on coffee lines (base $59.93 + 25%)");
  const contract6 = await fetchContract();
  for (const variant of [HAZELNUT, COCOA]) {
    const gid = lineGid(contract6, variant);
    if (!gid) throw new Error(`could not find line gid for variant ${variant}`);
    const url = `${APPSTLE}/subscription-contracts-update-line-item-pricing-policy?contractId=${C}&lineId=${encodeURIComponent(gid)}&basePrice=${BASE_PRICE}`;
    const pr = await fetch(url, {
      method: "PUT",
      headers: { "X-API-Key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify([{ afterCycle: 0, discountType: "PERCENTAGE", value: SNS_PCT }]),
      cache: "no-store",
    });
    if (!pr.ok) throw new Error(`pricing-policy ${variant} HTTP ${pr.status}: ${await pr.text()}`);
    console.log(`    ✓ ${variant} → base $${BASE_PRICE} + ${SNS_PCT}% (HTTP ${pr.status})`);
  }

  // 7) Sync DB items to match (2 Hazelnut + 1 Cocoa @ $44.95)
  console.log("\n[7] sync DB items");
  const finalContract = await fetchContract();
  const finalLines = ((finalContract.lines as Record<string, unknown>)?.nodes || []) as Record<string, unknown>[];
  const items = finalLines.map(l => {
    const v = String(l.variantId).split("/").pop()!;
    const cur = Math.round(parseFloat(String((l.currentPrice as Record<string, unknown>)?.amount ?? "0")) * 100);
    return {
      variant_id: v, title: String(l.title ?? ""), variant_title: String(l.variantTitle ?? ""),
      quantity: Number(l.quantity ?? 1), price_cents: cur,
    };
  });
  await admin.from("subscriptions").update({
    status: "active", items, applied_discounts: [], updated_at: new Date().toISOString(),
  }).eq("id", SUB_ID);
  console.log("    ✓ DB updated:", JSON.stringify(items));

  console.log("\nAFTER:"); summarize(finalContract);

  // Verification assertions
  console.log("\n=== VERIFY ===");
  const coffeeLines = finalLines.filter(l => String(l.title).includes("Amazing Coffee"));
  const totalBags = coffeeLines.reduce((n, l) => n + Number(l.quantity ?? 0), 0);
  const nonCoffee = finalLines.filter(l => !String(l.title).includes("Amazing Coffee"));
  const discs = ((finalContract.discounts as Record<string, unknown>)?.nodes || []) as Record<string, unknown>[];
  const allAt4495 = coffeeLines.every(l => String((l.currentPrice as Record<string, unknown>)?.amount) === "44.95");
  console.log(`  coffee bags total: ${totalBags} (want 3) ${totalBags === 3 ? "✓" : "✗"}`);
  console.log(`  non-coffee lines: ${nonCoffee.length} (want 0) ${nonCoffee.length === 0 ? "✓" : "✗"}`);
  console.log(`  all coffee @ $44.95: ${allAt4495 ? "✓" : "✗"}`);
  console.log(`  remaining discounts: ${discs.length} (want 0) ${discs.length === 0 ? "✓" : "✗"}`);
  console.log(`  status ACTIVE: ${finalContract.status === "ACTIVE" ? "✓" : "✗ (" + finalContract.status + ")"}`);
  if (totalBags === 3 && nonCoffee.length === 0 && allAt4495 && discs.length === 0 && finalContract.status === "ACTIVE") {
    console.log("\n✅ ALL CHECKS PASS — ready to bill (order now).");
  } else {
    console.log("\n⚠️  Some checks failed — review before billing.");
  }
}
main().catch(e => { console.error("✗ FAILED:", e); process.exit(1); });
