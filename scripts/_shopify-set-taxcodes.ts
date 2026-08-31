/**
 * Set the Avalara taxCode on every ACTIVE Shopify variant. CEO-directed 2026-08-31.
 *
 * Why this is the important half: Avalara reads Shopify's variant taxCode for all
 * Shopify-originated sales, and EVERY variant currently has it empty — so Avalara has been
 * classifying our whole catalogue as fully-taxable general merchandise. That covers ~5,980
 * Shopify-backed orders vs the 220 native ones the products-table fix addresses.
 *
 * Codes verified against Avalara's /definitions/taxcodes on 2026-08-31:
 *   PF050700  dietary supplements (supplement facts on label)  — exempt NY/TX, taxable CA
 *   PF050002  food for home consumption / basic groceries
 *   OS010100  shipping protection
 *   P0000000  tangible personal property (drinkware, mixers, mystery item)
 *
 * Classification order matters: "Bamboo Coffee Mug" must match merchandise before coffee.
 * Anything unclassified is REPORTED AND SKIPPED — never guessed, since a wrong code here
 * mis-taxes real customers.
 *
 * Pass --apply to write.
 */
import "./_bootstrap";
import { getShopifyCredentials } from "../src/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "../src/lib/shopify";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");

function classify(title: string): { code: string; why: string } | null {
  const t = title.toLowerCase();
  if (/shipping\s*protection|upcart|shopwill/.test(t)) return { code: "OS010100", why: "shipping protection" };
  if (/tumbler|mixer|mug|bottle|shaker|mystery item/.test(t)) return { code: "P0000000", why: "merchandise" };
  if (/tabs|ashwavana|ashwagandha|creatine|gumm|zen|guru focus|apple cider vinegar|sleep/.test(t)) {
    return { code: "PF050700", why: "dietary supplement" };
  }
  if (/coffee|creamer|k-?cup/.test(t)) return { code: "PF050002", why: "food / grocery" };
  return null;
}

async function main() {
  const creds = await getShopifyCredentials(WS);
  if (!creds) throw new Error("no Shopify credentials");
  const { shop, accessToken } = creds as { shop: string; accessToken: string };
  const gql = async (query: string, variables?: Record<string, unknown>) => {
    const r = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return r.json() as Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }>;
  };

  const read = await gql(`query { products(first: 100) { edges { node {
      id title status
      variants(first: 25) { edges { node { id title taxCode } } }
  } } } }`);
  if (read.errors?.length) throw new Error(`read: ${JSON.stringify(read.errors).slice(0, 300)}`);

  type P = { id: string; title: string; status: string; variants?: { edges?: Array<{ node: { id: string; title: string; taxCode: string | null } }> } };
  const products = ((read.data?.products as { edges?: Array<{ node: P }> })?.edges ?? []).map((e) => e.node).filter((p) => p.status === "ACTIVE");

  const plan: Array<{ pid: string; ptitle: string; vid: string; vtitle: string; from: string; to: string; why: string }> = [];
  const skipped: string[] = [];
  for (const p of products) {
    const c = classify(p.title);
    for (const ve of p.variants?.edges ?? []) {
      const v = ve.node;
      if (!c) { skipped.push(`${p.title} / ${v.title}`); continue; }
      const from = v.taxCode || "(empty)";
      if (v.taxCode === c.code) continue;
      plan.push({ pid: p.id, ptitle: p.title, vid: v.id, vtitle: v.title, from, to: c.code, why: c.why });
    }
  }

  console.log(`variants to set: ${plan.length}`);
  for (const x of plan) console.log(`   ${`${x.ptitle} / ${x.vtitle}`.slice(0, 52).padEnd(54)} ${x.from.padEnd(9)} → ${x.to}  (${x.why})`);
  if (skipped.length) {
    console.log(`\n⚠️ UNCLASSIFIED — skipped, not guessed (${skipped.length}):`);
    for (const s of skipped) console.log(`   ${s}`);
  }
  if (!APPLY) { console.log(`\nDRY RUN — pass --apply.`); return; }

  const byProduct = new Map<string, Array<{ id: string; taxCode: string }>>();
  for (const x of plan) {
    const arr = byProduct.get(x.pid) ?? [];
    arr.push({ id: x.vid, taxCode: x.to });
    byProduct.set(x.pid, arr);
  }

  let ok = 0, failed = 0;
  for (const [pid, variants] of byProduct) {
    const res = await gql(
      `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
         productVariantsBulkUpdate(productId: $productId, variants: $variants) {
           productVariants { id taxCode }
           userErrors { field message }
         } }`,
      { productId: pid, variants },
    );
    const payload = (res.data?.productVariantsBulkUpdate ?? {}) as { productVariants?: Array<{ id: string; taxCode: string | null }>; userErrors?: Array<{ message: string }> };
    if (res.errors?.length || payload.userErrors?.length) {
      failed += variants.length;
      console.error(`   ❌ ${pid}: ${JSON.stringify(res.errors ?? payload.userErrors).slice(0, 220)}`);
      continue;
    }
    for (const pv of payload.productVariants ?? []) {
      const want = variants.find((v) => v.id === pv.id)?.taxCode;
      if (pv.taxCode === want) ok += 1;
      else { failed += 1; console.error(`   ❌ ${pv.id}: wanted ${want}, Shopify returned ${pv.taxCode ?? "(empty)"}`); }
    }
  }
  console.log(`\n✅ set ${ok} variant tax codes${failed ? `, ❌ ${failed} failed` : ""}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
