/**
 * Script: Raise grandfathered line items to the 50% price floor.
 *
 * Usage:
 *   npx tsx scripts/fix-grandfathered-floor.ts          # dry run
 *   npx tsx scripts/fix-grandfathered-floor.ts --apply   # live run
 */

import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const FLOOR_PCT = 50;
const apply = process.argv.includes("--apply");
const EXCLUDE_CONTRACTS = new Set(["27855388845"]); // Dylan's test sub
const MIN_PRICE_CENTS = 1000; // Skip $0 items (influencers) and anything under $10

function decrypt(encrypted: string): string {
  const key = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
  const [ivHex, tagHex, ciphertextHex] = encrypted.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(ciphertextHex, "hex")).toString("utf8") + decipher.final("utf8");
}

async function main() {
  console.log(apply ? "🔴 LIVE RUN — changes will be applied" : "🟡 DRY RUN — no changes will be made");
  console.log("");

  // Get Appstle API key
  const { data: ws } = await admin.from("workspaces")
    .select("appstle_api_key_encrypted")
    .eq("id", WORKSPACE_ID).single();
  const apiKey = decrypt(ws!.appstle_api_key_encrypted);

  // Get product standard prices
  const { data: products } = await admin.from("products")
    .select("variants").eq("workspace_id", WORKSPACE_ID);
  const priceMap = new Map<string, number>();
  for (const p of products || []) {
    for (const v of (p.variants as { id?: string; price_cents?: number }[]) || []) {
      if (v.id && v.price_cents) priceMap.set(String(v.id), v.price_cents);
    }
  }

  // Paginate all active subs
  const toFix: { contractId: string; variantId: string; itemTitle: string; currentPrice: number; newBasePrice: number; standardPrice: number }[] = [];
  let page = 0;
  while (true) {
    const { data: subs } = await admin.from("subscriptions")
      .select("shopify_contract_id, items")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("status", "active")
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!subs || subs.length === 0) break;

    for (const sub of subs) {
      if (EXCLUDE_CONTRACTS.has(sub.shopify_contract_id)) continue;
      for (const item of (sub.items as { variant_id?: string; price_cents?: number; title?: string; variant_title?: string; line_id?: string }[]) || []) {
        if (!item.price_cents || item.price_cents < MIN_PRICE_CENTS || !item.variant_id) continue;
        const effectiveBase = Math.round(item.price_cents / 0.75);
        const standardPrice = priceMap.get(String(item.variant_id));
        if (!standardPrice || effectiveBase >= standardPrice) continue;

        const pctOfStandard = item.price_cents / (standardPrice * 0.75) * 100;
        if (pctOfStandard >= FLOOR_PCT) continue;

        // Calculate new base price at the floor
        const floorDiscountedPrice = Math.round(standardPrice * 0.75 * (FLOOR_PCT / 100));
        const newBasePrice = Math.round(floorDiscountedPrice / 0.75);

        toFix.push({
          contractId: sub.shopify_contract_id,
          variantId: item.variant_id,
          itemTitle: `${item.title || "?"} ${item.variant_title || ""}`.trim(),
          currentPrice: item.price_cents,
          newBasePrice,
          standardPrice,
        });
      }
    }
    if (subs.length < 1000) break;
    page++;
  }

  console.log(`Found ${toFix.length} line items below ${FLOOR_PCT}% floor\n`);

  let success = 0;
  let failed = 0;

  for (const fix of toFix) {
    const currentPct = (fix.currentPrice / (fix.standardPrice * 0.75) * 100).toFixed(1);
    console.log(`${fix.contractId} | ${fix.itemTitle} | $${(fix.currentPrice / 100).toFixed(2)} (${currentPct}%) → base $${(fix.newBasePrice / 100).toFixed(2)} (${FLOOR_PCT}%)`);

    if (!apply) continue;

    // Get lineId from Appstle
    try {
      const detailRes = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts/contract-external/${fix.contractId}?api_key=${apiKey}`,
        { headers: { "X-API-Key": apiKey } },
      );
      if (!detailRes.ok) { console.log("  ❌ Failed to fetch contract details"); failed++; continue; }
      const detail = await detailRes.json();
      const lines = (detail?.lines?.nodes || []) as { id?: string; variantId?: string }[];
      const lineMatch = lines.find(l => {
        const vid = l.variantId?.split("/").pop();
        return String(vid) === String(fix.variantId);
      });
      if (!lineMatch?.id) { console.log("  ❌ Could not find lineId"); failed++; continue; }

      const res = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-line-item-price?contractId=${fix.contractId}&lineId=${encodeURIComponent(lineMatch.id)}&basePrice=${(fix.newBasePrice / 100).toFixed(2)}`,
        { method: "PUT", headers: { "X-API-Key": apiKey, "Content-Type": "application/json" } },
      );
      if (res.ok) {
        console.log("  ✅ Updated");
        success++;
      } else {
        console.log("  ❌ API returned", res.status);
        failed++;
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.log("  ❌ Error:", (e as Error).message);
      failed++;
    }
  }

  console.log(`\nDone. ${apply ? `Success: ${success}, Failed: ${failed}` : `${toFix.length} items would be updated`}`);
}

main().catch(console.error);
