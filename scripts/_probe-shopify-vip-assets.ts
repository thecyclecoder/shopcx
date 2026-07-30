/**
 * Probe: do the coupon codes + collections a VIP-weekend blast would point at
 * actually exist in Shopify? Read-only GraphQL — mints nothing.
 *
 * The SMS skill's hard rule is `coupon_enabled=false` + the code living in the
 * `/discount/{CODE}` shortlink target, so the code MUST already exist or every
 * recipient lands on a dead discount URL.
 */
import "./_bootstrap";
import { getShopifyCredentials } from "../src/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "../src/lib/shopify";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const CODES = ["VIPONLY"];
const COLLECTIONS = ["special-vip-sale"];

const CODE_Q = `query($code: String!) {
  codeDiscountNodeByCode(code: $code) {
    id
    codeDiscount {
      __typename
      ... on DiscountCodeBasic {
        title status startsAt endsAt
        customerGets { value { __typename
          ... on DiscountPercentage { percentage }
          ... on DiscountAmount { amount { amount currencyCode } } } }
        codes(first: 3) { nodes { code } }
      }
    }
  }
}`;

const COLL_Q = `query($handle: String!) {
  collectionByHandle(handle: $handle) { id title handle productsCount { count } }
}`;

async function gql(shop: string, token: string, query: string, variables: any) {
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`shopify_${res.status}:${JSON.stringify(json).slice(0, 200)}`);
  if (json.errors) throw new Error(`gql_errors:${JSON.stringify(json.errors).slice(0, 300)}`);
  return json.data;
}

async function main() {
  const { shop, accessToken } = await getShopifyCredentials(WS);
  console.log(`shop: ${shop}\n`);

  console.log("=== DISCOUNT CODES ===");
  for (const code of CODES) {
    try {
      const d = await gql(shop, accessToken, CODE_Q, { code });
      const node = d?.codeDiscountNodeByCode;
      if (!node) {
        console.log(`  ${code.padEnd(12)} MISSING (does not exist in Shopify)`);
        continue;
      }
      const cd = node.codeDiscount || {};
      const v = cd.customerGets?.value;
      const amount =
        v?.__typename === "DiscountPercentage"
          ? `${Math.round((v.percentage || 0) * 100)}%`
          : v?.amount
            ? `${v.amount.amount} ${v.amount.currencyCode}`
            : "?";
      console.log(
        `  ${code.padEnd(12)} ${String(cd.status).padEnd(9)} ${amount.padEnd(6)} starts=${cd.startsAt || "-"} ends=${cd.endsAt || "none"}  "${cd.title || ""}"`,
      );
    } catch (e) {
      console.log(`  ${code.padEnd(12)} ERROR ${(e as Error).message}`);
    }
  }

  console.log("\n=== COLLECTIONS ===");
  for (const handle of COLLECTIONS) {
    try {
      const d = await gql(shop, accessToken, COLL_Q, { handle });
      const c = d?.collectionByHandle;
      if (!c) console.log(`  ${handle.padEnd(22)} MISSING`);
      else console.log(`  ${handle.padEnd(22)} ok  "${c.title}"  products=${c.productsCount?.count}`);
    } catch (e) {
      console.log(`  ${handle.padEnd(22)} ERROR ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
