/**
 * Backfill `orders.payment_details.card_bin` (+ last4/company/exp) from Shopify.
 *
 * `bin_velocity` (src/lib/fraud-detector.ts) only sees card BINs captured since
 * 2026-06-11. This seeds history so the rule is effective immediately. Pulls the
 * first transaction's CardPaymentDetails per order and MERGES the card fields
 * into payment_details (never clobbering the checkout breakdown stored there).
 *
 *   npx tsx scripts/_backfill-card-bins.ts <workspaceId> [days=30] [--apply]
 *
 * Default is a dry run (counts only). Pass --apply to write. Bounded by `days`
 * because each order = one Shopify GraphQL call (rate-limited, ~4/s).
 */
import { readFileSync } from "fs";
import { resolve } from "path";
for (const l of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split("\n")) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const e = t.indexOf("=");
  if (e < 0) continue;
  if (!process.env[t.slice(0, e)]) process.env[t.slice(0, e)] = t.slice(e + 1);
}
import { createAdminClient } from "@/lib/supabase/admin";

async function main() {
  const workspaceId = process.argv[2];
  const days = Number(process.argv[3] && !process.argv[3].startsWith("--") ? process.argv[3] : 30);
  const apply = process.argv.includes("--apply");
  if (!workspaceId) throw new Error("usage: _backfill-card-bins.ts <workspaceId> [days] [--apply]");

  const admin = createAdminClient();
  const { getShopifyCredentials } = await import("@/lib/shopify-sync");
  const { SHOPIFY_API_VERSION } = await import("@/lib/shopify");
  const { shop, accessToken } = await getShopifyCredentials(workspaceId);

  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data: orders } = await admin
    .from("orders")
    .select("id, shopify_order_id, payment_details, subscription_id")
    .eq("workspace_id", workspaceId)
    .gte("created_at", since)
    .is("subscription_id", null)
    .not("shopify_order_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(5000);

  const todo = (orders || []).filter((o) => {
    const pd = o.payment_details && typeof o.payment_details === "object" ? (o.payment_details as Record<string, unknown>) : null;
    return !pd?.card_bin;
  });
  console.log(`${(orders || []).length} orders in ${days}d · ${todo.length} missing card_bin · mode=${apply ? "APPLY" : "DRY"}`);

  let captured = 0;
  for (const o of todo) {
    const gid = String(o.shopify_order_id).includes("gid://") ? String(o.shopify_order_id) : `gid://shopify/Order/${o.shopify_order_id}`;
    const query = `{ order(id:"${gid}"){ transactions(first:5){ gateway paymentDetails{ ...on CardPaymentDetails{ name number bin company expirationMonth expirationYear } } } } }`;
    try {
      const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) continue;
      const j = await res.json();
      const txns = j?.data?.order?.transactions || [];
      const t = txns.find((x: { paymentDetails?: { bin?: string } }) => x.paymentDetails?.bin) || txns[0];
      const card = t?.paymentDetails;
      if (!card?.bin) continue;
      const existingPd = o.payment_details && typeof o.payment_details === "object" ? (o.payment_details as Record<string, unknown>) : {};
      const merged = {
        ...existingPd,
        gateway: t.gateway,
        card_bin: String(card.bin).replace(/\D/g, ""),
        card_last4: String(card.number || "").replace(/\D/g, "").slice(-4),
        card_company: card.company || null,
        card_name: card.name || null,
        card_exp: `${card.expirationMonth || ""}/${card.expirationYear || ""}`,
      };
      captured++;
      if (apply) await admin.from("orders").update({ payment_details: merged }).eq("id", o.id);
    } catch {
      /* skip */
    }
    await new Promise((r) => setTimeout(r, 250)); // ~4 req/s, well under Shopify's limit
  }
  console.log(`Captured BIN for ${captured}/${todo.length} orders${apply ? " (written)" : " (dry run — re-run with --apply)"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
