import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";
const V = "v21.0";
async function g(path: string, token: string, params: Record<string,string> = {}) {
  const u = new URL(`https://graph.facebook.com/${V}/${path}`);
  for (const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
  u.searchParams.set("access_token", token);
  const r = await fetch(u); const j = await r.json();
  if (j.error) return { __err: j.error.message };
  return j;
}
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id,name").limit(20);
  let token: string | null = null;
  for (const w of ws ?? []) { token = await getMetaUserToken(w.id); if (token) break; }
  if (!token) throw new Error("no token");

  console.log("=== PAGES + SHOP STATUS ===");
  const pages = await g("me/accounts", token, { fields: "id,name,shop_setup_status,has_transitioned_to_new_page_api" });
  for (const p of pages.data ?? []) {
    console.log(`\n  PAGE ${p.name} (${p.id}) shop_setup_status=${p.shop_setup_status ?? "(n/a)"}`);
    const cms = await g(`${p.id}/commerce_merchant_settings`, token, { fields: "id,shops{id,fb_sales_channel,ig_sales_channel,shop_status},merchant_status,checkout_settings" });
    console.log(`    commerce_merchant_settings: ${JSON.stringify(cms).slice(0,500)}`);
  }

  console.log("\n\n=== BUSINESSES → CATALOGS + COMMERCE ===");
  const bizzes = await g("me/businesses", token, { fields: "id,name" });
  for (const b of bizzes.data ?? []) {
    const cats = await g(`${b.id}/owned_product_catalogs`, token, { fields: "id,name,product_count" });
    const cms = await g(`${b.id}/commerce_merchant_settings`, token, { fields: "id,display_name,merchant_status,shops{id,shop_status,fb_sales_channel,ig_sales_channel}" });
    console.log(`\n  BUSINESS ${b.name} (${b.id})`);
    console.log(`    catalogs: ${JSON.stringify(cats.data ?? cats).slice(0,400)}`);
    console.log(`    commerce: ${JSON.stringify(cms.data ?? cms).slice(0,600)}`);
  }
})();
