/**
 * Backfill 1 year of orders missing shipping or billing address.
 *
 * For every order created in the last 365 days where shipping_address
 * OR billing_address is null in our DB:
 *   1. Hit Shopify GraphQL for the order
 *   2. Apply the address fallback chain:
 *        Order.shippingAddress → Order.billingAddress → Customer.defaultAddress
 *   3. If only one populated, mirror into both columns
 *   4. Update the orders row (only fields that are currently null)
 *
 * Read-only on Shopify. Writes only to orders table.
 *
 * Run: npx tsx scripts/backfill-1yr-addresses.ts
 *
 * Pacing: 350ms between Shopify GraphQL calls (~170 req/min, well
 * under the 50/sec admin API limit). Expected ~30k orders × 350ms =
 * ~3 hours per workspace if every order needed the call. Most are
 * already filled so the actual run will be much shorter.
 */
import { readFileSync } from "fs";

const envPath = "/Users/admin/Projects/shopcx/.env.local";
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

interface ShopifyAddr {
  firstName?: string;
  lastName?: string;
  address1?: string;
  address2?: string | null;
  city?: string;
  province?: string;
  provinceCode?: string;
  country?: string;
  countryCodeV2?: string;
  zip?: string;
  phone?: string | null;
}

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { getShopifyCredentials } = await import("../src/lib/shopify-sync");
  const { SHOPIFY_API_VERSION } = await import("../src/lib/shopify");
  const { resolveOrderAddresses } = await import("../src/lib/address-normalize");
  const admin = createAdminClient();

  const { data: workspaces } = await admin
    .from("workspaces")
    .select("id, name")
    .not("shopify_access_token_encrypted", "is", null);

  for (const ws of workspaces || []) {
    console.log(`\n══ ${ws.name} (${ws.id}) ══`);
    const { shop, accessToken } = await getShopifyCredentials(ws.id);

    const sinceISO = new Date(Date.now() - 365 * 86400 * 1000).toISOString();

    // Pull every order missing one or both address fields
    type Order = {
      id: string;
      order_number: string;
      shopify_order_id: string;
      shipping_address: Record<string, unknown> | null;
      billing_address: Record<string, unknown> | null;
      created_at: string;
    };
    const targets: Order[] = [];
    let cursor: string | null = null;
    for (;;) {
      let q = admin.from("orders")
        .select("id, order_number, shopify_order_id, shipping_address, billing_address, created_at")
        .eq("workspace_id", ws.id)
        .gte("created_at", sinceISO)
        .order("created_at", { ascending: false })
        .limit(1000);
      if (cursor) q = q.lt("created_at", cursor);
      const { data, error } = await q;
      if (error) { console.error("select error:", error.message); break; }
      if (!data?.length) break;
      for (const o of data as unknown as Order[]) {
        if (!o.shipping_address || !o.billing_address) targets.push(o);
      }
      cursor = data[data.length - 1].created_at;
      if (data.length < 1000) break;
      process.stdout.write(`\r  scanning… ${targets.length} candidates so far`);
    }
    console.log(`\n  ${targets.length} orders need a backfill.`);

    let updated = 0;
    let bothNull = 0;
    let mirrored = 0;
    let bothFilled = 0;
    let usedDefault = 0;
    let i = 0;

    for (const o of targets) {
      i++;
      const gid = `gid://shopify/Order/${o.shopify_order_id}`;
      const query = `{
        order(id: "${gid}") {
          shippingAddress { firstName lastName address1 address2 city province provinceCode country countryCodeV2 zip phone }
          billingAddress  { firstName lastName address1 address2 city province provinceCode country countryCodeV2 zip phone }
          customer {
            defaultAddress { firstName lastName address1 address2 city province provinceCode country countryCodeV2 zip phone }
          }
        }
      }`;
      try {
        const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
          method: "POST",
          headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
          body: JSON.stringify({ query }),
        });
        if (!res.ok) {
          if (res.status === 429) {
            // Rate limited — back off
            await new Promise(r => setTimeout(r, 2000));
            continue;
          }
          throw new Error(`Shopify GraphQL ${res.status}`);
        }
        const j = await res.json();
        const ord = j.data?.order;
        const ship = (ord?.shippingAddress || null) as ShopifyAddr | null;
        const bill = (ord?.billingAddress || null) as ShopifyAddr | null;
        const def = (ord?.customer?.defaultAddress || null) as ShopifyAddr | null;

        const resolved = resolveOrderAddresses(
          ship as Record<string, unknown> | null,
          bill as Record<string, unknown> | null,
          def as Record<string, unknown> | null,
        );
        if (!resolved.shipping_address && !resolved.billing_address) {
          bothNull++;
        } else if (ship && bill) {
          bothFilled++;
        } else if ((ship && !bill) || (bill && !ship)) {
          mirrored++;
        } else if (def) {
          usedDefault++;
        }

        const updates: Record<string, unknown> = {};
        if (!o.shipping_address && resolved.shipping_address) updates.shipping_address = resolved.shipping_address;
        if (!o.billing_address && resolved.billing_address) updates.billing_address = resolved.billing_address;
        if (Object.keys(updates).length > 0) {
          const { error } = await admin.from("orders").update(updates).eq("id", o.id);
          if (!error) updated++;
        }
      } catch (e) {
        console.log(`\n  ${o.order_number} ERROR: ${e instanceof Error ? e.message : "unknown"}`);
      }

      if (i % 50 === 0) {
        process.stdout.write(`\r  processed ${i}/${targets.length}  updated=${updated}  mirrored=${mirrored}  default=${usedDefault}  bothNull=${bothNull}`);
      }
      await new Promise(r => setTimeout(r, 350));
    }

    console.log("\n  ─ Done ─");
    console.log(`  Both populated:        ${bothFilled}`);
    console.log(`  Mirrored (one→both):   ${mirrored}`);
    console.log(`  Used customer default: ${usedDefault}`);
    console.log(`  Both null upstream:    ${bothNull}`);
    console.log(`  Rows updated:          ${updated}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
