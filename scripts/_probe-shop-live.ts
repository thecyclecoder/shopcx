import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";
const V = "v21.0";
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id,name").limit(20);
  let token: string | null = null;
  for (const w of ws ?? []) { token = await getMetaUserToken(w.id); if (token) break; }
  const g = async (p: string, q: Record<string,string> = {}) => {
    const u = new URL(`https://graph.facebook.com/${V}/${p}`);
    for (const [k,v] of Object.entries(q)) u.searchParams.set(k,v);
    u.searchParams.set("access_token", token!);
    return (await fetch(u)).json();
  };
  // page id off a live ad creative
  const ads = await g("act_196487894712827/ads", { fields: "name,effective_status,creative{object_story_spec}", limit: "50" });
  const live = (ads.data ?? []).find((a: any) => a.effective_status === "ACTIVE");
  const pageId = live?.creative?.object_story_spec?.page_id;
  console.log(`page_id from live ad = ${pageId}`);
  const page = await g(`${pageId}`, { fields: "id,name,link,shop_setup_status,storefront_shop_urls,commerce_settings" });
  console.log("PAGE:", JSON.stringify(page));
  for (const edge of ["commerce_merchant_settings", "product_catalogs", "shop_setup_status"]) {
    const r = await g(`${pageId}/${edge}`);
    console.log(`  ${edge}: ${JSON.stringify(r).slice(0, 300)}`);
  }
})();
