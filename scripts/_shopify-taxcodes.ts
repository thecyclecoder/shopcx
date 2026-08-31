/**
 * Read the taxCode Shopify currently holds on every variant.
 * Avalara reads THIS for all Shopify-originated sales (CEO 2026-08-31), so it governs the
 * ~5,980 Shopify-backed orders — a far bigger surface than our 220 native ones.
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getShopifyCredentials } from "../src/lib/shopify-sync";
import { SHOPIFY_API_VERSION } from "../src/lib/shopify";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const creds = await getShopifyCredentials(WS);
  if (!creds) throw new Error("no Shopify credentials for this workspace");
  const { shop, accessToken } = creds as { shop: string; accessToken: string };
  console.log(`shop: ${shop}  api: ${SHOPIFY_API_VERSION}\n`);

  const query = `
    query {
      products(first: 50) {
        edges { node {
          id title status
          variants(first: 25) { edges { node { id title taxable taxCode } } }
        } }
      }
    }`;

  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await res.json() as {
    data?: { products?: { edges?: Array<{ node: { id: string; title: string; status: string; variants?: { edges?: Array<{ node: { id: string; title: string; taxable: boolean; taxCode: string | null } }> } } }> } };
    errors?: Array<{ message: string }>;
  };
  if (j.errors?.length) { console.error(`GraphQL errors: ${JSON.stringify(j.errors).slice(0, 400)}`); return; }

  const { data: prods } = await admin.from("products").select("title,avalara_tax_code").eq("workspace_id", WS);
  const want = new Map((prods ?? []).map((p) => [String(p.title), String(p.avalara_tax_code ?? "")]));

  console.log(`product / variant                                  shopify taxCode   should be`);
  for (const e of j.data?.products?.edges ?? []) {
    const p = e.node;
    if (p.status !== "ACTIVE") continue;
    const target = want.get(p.title) ?? "(not in our catalog)";
    for (const v of p.variants?.edges ?? []) {
      const cur = v.node.taxCode ?? "—";
      const mark = cur !== target && target && !target.startsWith("(") ? "   ← needs update" : "";
      console.log(`${`${p.title} / ${v.node.title}`.slice(0, 48).padEnd(50)} ${String(cur).padEnd(17)} ${target}${mark}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
