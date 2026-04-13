/**
 * Script: Remove sale coupons from grandfathered subs that would take price below 50% floor.
 * Loyalty coupons (LOYALTY-*, smile-*) are always kept.
 *
 * Usage:
 *   npx tsx scripts/remove-grandfathered-coupons.ts          # dry run
 *   npx tsx scripts/remove-grandfathered-coupons.ts --apply   # live run
 */

import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const FLOOR_PCT = 50;
const apply = process.argv.includes("--apply");
const EXCLUDE_CONTRACTS = new Set(["27855388845"]);
const LOYALTY_PREFIXES = ["LOYALTY-", "smile-"];

function decrypt(encrypted: string): string {
  const key = Buffer.from(process.env.ENCRYPTION_KEY!, "hex");
  const [ivHex, tagHex, ciphertextHex] = encrypted.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(ciphertextHex, "hex")).toString("utf8") + decipher.final("utf8");
}

function isLoyaltyCoupon(title: string): boolean {
  return LOYALTY_PREFIXES.some(p => title.startsWith(p));
}

async function getShopifyCouponValue(shop: string, token: string, code: string): Promise<{ pct: number; fixed: number }> {
  try {
    const res = await fetch(`https://${shop}/admin/api/2025-07/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{ codeDiscountNodeByCode(code: "${code}") { codeDiscount { ... on DiscountCodeBasic { customerGets { value { ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount } } } } } } } }`,
      }),
    });
    const data = await res.json();
    const val = data?.data?.codeDiscountNodeByCode?.codeDiscount?.customerGets?.value;
    if (val?.percentage) return { pct: val.percentage * 100, fixed: 0 };
    if (val?.amount?.amount) return { pct: 0, fixed: parseFloat(val.amount.amount) * 100 };
  } catch {}
  return { pct: 0, fixed: 0 };
}

async function main() {
  console.log(apply ? "🔴 LIVE RUN — coupons will be removed" : "🟡 DRY RUN — no changes will be made");
  console.log("");

  const { data: ws } = await admin.from("workspaces")
    .select("appstle_api_key_encrypted, shopify_myshopify_domain, shopify_access_token_encrypted")
    .eq("id", WORKSPACE_ID).single();
  const apiKey = decrypt(ws!.appstle_api_key_encrypted);
  const shop = ws!.shopify_myshopify_domain;
  const shopToken = decrypt(ws!.shopify_access_token_encrypted);

  // Product prices
  const { data: products } = await admin.from("products").select("variants").eq("workspace_id", WORKSPACE_ID);
  const priceMap = new Map<string, number>();
  for (const p of products || []) {
    for (const v of (p.variants as { id?: string; price_cents?: number }[]) || []) {
      if (v.id && v.price_cents) priceMap.set(String(v.id), v.price_cents);
    }
  }

  // Cache coupon values
  const couponCache = new Map<string, { pct: number; fixed: number }>();

  const toRemove: { contractId: string; discountId: string; discountTitle: string; customerName: string; reason: string }[] = [];

  let page = 0;
  while (true) {
    const { data: subs } = await admin.from("subscriptions")
      .select("shopify_contract_id, items, applied_discounts, customer_id")
      .eq("workspace_id", WORKSPACE_ID)
      .eq("status", "active")
      .range(page * 1000, (page + 1) * 1000 - 1);
    if (!subs || subs.length === 0) break;

    for (const sub of subs) {
      if (EXCLUDE_CONTRACTS.has(sub.shopify_contract_id)) continue;
      const discounts = (sub.applied_discounts as { id: string; title: string; type: string; value: number; valueType: string }[]) || [];
      const codeCoupons = discounts.filter(d => d.type === "CODE_DISCOUNT");
      if (codeCoupons.length === 0) continue;

      // Check if sub has grandfathered items
      const items = (sub.items as { variant_id?: string; price_cents?: number; title?: string }[]) || [];
      const hasGrandfathered = items.some(i => {
        if (!i.price_cents || !i.variant_id) return false;
        const effectiveBase = Math.round(i.price_cents / 0.75);
        const std = priceMap.get(String(i.variant_id));
        return std ? effectiveBase < std : false;
      });
      if (!hasGrandfathered) continue;

      // Get customer name
      const { data: cust } = await admin.from("customers").select("first_name, last_name, email").eq("id", sub.customer_id).single();
      const custName = [cust?.first_name, cust?.last_name].filter(Boolean).join(" ") || cust?.email || "unknown";

      for (const coupon of codeCoupons) {
        if (isLoyaltyCoupon(coupon.title)) continue;

        // Look up coupon value from Shopify
        if (!couponCache.has(coupon.title)) {
          couponCache.set(coupon.title, await getShopifyCouponValue(shop, shopToken, coupon.title));
          await new Promise(r => setTimeout(r, 100));
        }
        const couponVal = couponCache.get(coupon.title)!;

        // Check if any grandfathered item would drop below floor with this coupon
        let wouldBreachFloor = false;
        for (const item of items) {
          if (!item.price_cents || !item.variant_id) continue;
          const std = priceMap.get(String(item.variant_id));
          if (!std) continue;
          const effectiveBase = Math.round(item.price_cents / 0.75);
          if (effectiveBase >= std) continue; // Not grandfathered

          const floorPrice = std * 0.75 * (FLOOR_PCT / 100);
          let afterCoupon = item.price_cents;
          if (couponVal.pct > 0) afterCoupon = Math.round(item.price_cents * (1 - couponVal.pct / 100));
          else if (couponVal.fixed > 0) afterCoupon = item.price_cents - couponVal.fixed;

          if (afterCoupon < floorPrice) {
            wouldBreachFloor = true;
            break;
          }
        }

        if (wouldBreachFloor) {
          toRemove.push({
            contractId: sub.shopify_contract_id,
            discountId: coupon.id,
            discountTitle: coupon.title,
            customerName: custName,
            reason: `Would breach ${FLOOR_PCT}% floor on grandfathered pricing`,
          });
        }
      }
    }
    if (subs.length < 1000) break;
    page++;
  }

  console.log(`Found ${toRemove.length} coupons to remove\n`);

  let success = 0;
  let failed = 0;

  for (const rm of toRemove) {
    console.log(`${rm.contractId} | ${rm.customerName} | ${rm.discountTitle} — ${rm.reason}`);

    if (!apply) continue;

    try {
      const res = await fetch(
        `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-remove-discount?contractId=${rm.contractId}&discountId=${encodeURIComponent(rm.discountId)}&api_key=${apiKey}`,
        { method: "PUT", headers: { "X-API-Key": apiKey } },
      );
      if (res.ok || res.status === 204) {
        console.log("  ✅ Removed");
        success++;
      } else {
        console.log("  ❌ API returned", res.status);
        failed++;
      }
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.log("  ❌ Error:", (e as Error).message);
      failed++;
    }
  }

  console.log(`\nDone. ${apply ? `Removed: ${success}, Failed: ${failed}` : `${toRemove.length} coupons would be removed`}`);
}

main().catch(console.error);
