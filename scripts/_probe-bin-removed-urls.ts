import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const admin = createAdminClient();
  const { readyToTest } = await listReadyToTest(admin, { workspaceId: WS });
  console.log(`listReadyToTest → ${readyToTest.length} ready campaigns`);
  const ids = readyToTest.map(r => r.ad_campaign_id);
  // Inspect each ready campaign's landing_url + status + product
  const { data: camps } = await admin.from("ad_campaigns")
    .select("id, name, status, landing_url, product_id")
    .eq("workspace_id", WS).in("id", ids.length ? ids : ["_none_"]);
  const byProd = new Map<string, {c:any}[]>();
  for (const c of (camps||[]) as any[]) {
    const k = c.product_id ?? "null";
    (byProd.get(k) ?? byProd.set(k, []).get(k)!).push({c});
  }
  for (const [pid, list] of byProd) {
    console.log(`\nproduct ${pid?.slice(0,8)} — ${list.length} ready:`);
    for (const {c} of list) {
      const url = c.landing_url;
      const flag = !url ? "❌NULL" : (url.trim()==="" ? "❌EMPTY" : "");
      console.log(`  [${c.status}] ${flag} url=${url ? url.slice(0,60) : "(none)"}  ${c.name?.slice(0,40)}`);
    }
  }
})().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
