/**
 * Adopt every LIVE Shopify contract our app owns that has no `subscriptions` row.
 *
 * ⭐ Why. `subscription_contracts/create` fell to the webhook route's `default:` no-op until
 * 2026-09-17, so PDP checkouts in that window produced contracts that exist on Shopify and nowhere
 * in ShopCX. Shopify charges nothing on its own, so each one is a subscriber who would never be
 * billed — and nothing errors to say so. Two were found live (36020093101, 36020289709).
 *
 * Idempotent: `ingestShopifyContract`'s claim check refuses anything already ingested, created by
 * the Appstle migration, created by the one-time-charge rail, or not ACTIVE/PAUSED. Re-running
 * reports skips and writes nothing.
 *
 * Reads SHOPIFY, never Appstle — no metered calls.
 *
 * Usage: `npx tsx scripts/_backfill-uningested-shopify-contracts.ts [--apply]`
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { decrypt } from "../src/lib/crypto";
import { ingestShopifyContract } from "../src/lib/commerce/shopcx-contract-ingest";
import { SHOPIFY_API_VERSION } from "../src/lib/shopify";

const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();
  const { data: workspaces } = await admin
    .from("workspaces")
    .select("id, shopify_myshopify_domain, shopify_access_token_encrypted")
    .not("shopify_access_token_encrypted", "is", null);

  for (const w of workspaces ?? []) {
    if (!w.shopify_myshopify_domain) continue;
    const token = decrypt(w.shopify_access_token_encrypted as string);

    // Page the app's own contracts. `read_own_subscription_contracts` already scopes this to
    // contracts we created or adopted, so there is nothing else on the shop to walk.
    let cursor: string | null = null;
    const found: { id: string; status: string }[] = [];
    do {
      const res: Response = await fetch(
        `https://${w.shopify_myshopify_domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: { "X-Shopify-Access-Token": token, "Content-Type": "application/json" },
          body: JSON.stringify({
            query: `query($after:String){ subscriptionContracts(first:100, after:$after){
              pageInfo { hasNextPage endCursor }
              edges { node { id status } } } }`,
            variables: { after: cursor },
          }),
        },
      );
      const j = await res.json();
      if (j.errors) { console.error(`${w.id}: ${JSON.stringify(j.errors)}`); break; }
      const page = j.data.subscriptionContracts;
      for (const e of page.edges) {
        found.push({ id: String(e.node.id).replace("gid://shopify/SubscriptionContract/", ""), status: e.node.status });
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);

    const live = found.filter((c) => c.status === "ACTIVE" || c.status === "PAUSED");
    console.log(`\n${w.shopify_myshopify_domain}: ${found.length} app-owned contract(s), ${live.length} live`);

    let ingested = 0;
    for (const c of live) {
      const { data: existing } = await admin
        .from("subscriptions").select("id")
        .eq("workspace_id", w.id).eq("shopify_contract_id", c.id).maybeSingle();
      if (existing) continue;

      if (!APPLY) { console.log(`  [dry] ${c.id} (${c.status}) — no subscriptions row`); continue; }
      const r = await ingestShopifyContract(w.id, c.id);
      console.log(`  ${c.id}: ${r.ingested ? `ingested → ${r.subscriptionId}` : `skipped — ${r.reason}`}`);
      if (r.ingested) ingested++;
    }
    if (APPLY) console.log(`  ${ingested} adopted`);
  }
  if (!APPLY) console.log("\ndry run — pass --apply to write");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
