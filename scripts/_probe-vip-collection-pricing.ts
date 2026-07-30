/**
 * Probe: what is the REAL maximum discount off MSRP for the special-vip-sale
 * collection once the VIPONLY code stacks on the already-marked-down price?
 *
 * The promo phrase goes out to ~10K customers, so it needs to be measured, not
 * inherited from the last campaign. Read-only Shopify GraphQL.
 */
import "./_bootstrap";
import { getShopifyCredentials } from "../src/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "../src/lib/shopify";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const COLLECTION = "special-vip-sale";
const COUPON_PCT = 0.19; // VIPONLY, verified ACTIVE in Shopify

const Q = `query($handle: String!) {
  collectionByHandle(handle: $handle) {
    title
    products(first: 50) {
      nodes {
        title
        variants(first: 50) {
          nodes { title price compareAtPrice availableForSale }
        }
      }
    }
  }
}`;

async function main() {
  const { shop, accessToken } = await getShopifyCredentials(WS);
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
    body: JSON.stringify({ query: Q, variables: { handle: COLLECTION } }),
  });
  const json: any = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 300));
  const coll = json?.data?.collectionByHandle;
  if (!coll) throw new Error("collection_not_found");

  console.log(`Collection: "${coll.title}"  (coupon VIPONLY = ${COUPON_PCT * 100}%)\n`);

  let best = { label: "", pct: 0 };
  for (const p of coll.products.nodes) {
    console.log(p.title);
    for (const v of p.variants.nodes) {
      const price = parseFloat(v.price);
      const msrp = v.compareAtPrice ? parseFloat(v.compareAtPrice) : null;
      const afterCoupon = price * (1 - COUPON_PCT);
      const offMsrp = msrp && msrp > 0 ? (1 - afterCoupon / msrp) * 100 : null;
      const offList = (1 - afterCoupon / price) * 100;
      const line =
        `  ${(v.title || "-").padEnd(24)} list $${price.toFixed(2)}` +
        `  msrp ${msrp ? "$" + msrp.toFixed(2) : "  -   "}` +
        `  after VIPONLY $${afterCoupon.toFixed(2)}` +
        `  off-MSRP ${offMsrp === null ? " n/a" : offMsrp.toFixed(1) + "%"}` +
        `  off-list ${offList.toFixed(1)}%` +
        `${v.availableForSale ? "" : "  [SOLD OUT]"}`;
      console.log(line);
      if (offMsrp !== null && offMsrp > best.pct && v.availableForSale) {
        best = { label: `${p.title} / ${v.title}`, pct: offMsrp };
      }
    }
  }

  console.log(
    `\nMAX honest claim (in-stock, off MSRP, incl. VIPONLY): ${best.pct.toFixed(1)}%  — ${best.label}`,
  );
  console.log(`=> safe promo phrase: "up to ${Math.floor(best.pct / 5) * 5}% off"`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
