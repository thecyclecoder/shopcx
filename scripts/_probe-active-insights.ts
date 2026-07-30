import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";
const V = "v21.0";
async function g(path: string, token: string, params: Record<string,string> = {}) {
  const u = new URL(`https://graph.facebook.com/${V}/${path}`);
  for (const [k,v] of Object.entries(params)) u.searchParams.set(k,v);
  u.searchParams.set("access_token", token);
  const r = await fetch(u); const j = await r.json();
  if (j.error) { console.log(`  !! ${path}: ${j.error.message}`); return {}; }
  return j;
}
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id,name").limit(20);
  let token: string | null = null;
  for (const w of ws ?? []) { token = await getMetaUserToken(w.id); if (token) break; }
  if (!token) throw new Error("no token");
  const accts = await g("me/adaccounts", token, { fields: "id,name" });
  for (const a of accts.data ?? []) {
    const ads = await g(`${a.id}/ads`, token, { fields: "id,name,effective_status", limit: "100" });
    const active = (ads.data ?? []).filter((x: any) => x.effective_status === "ACTIVE");
    if (!active.length) continue;
    console.log(`\n########## ${a.name} (${a.id}) ##########`);
    for (const ad of active) {
      const ins = await g(`${ad.id}/insights`, token, {
        fields: "spend,impressions,clicks,inline_link_clicks,actions",
        date_preset: "last_30d",
      });
      const r = (ins.data ?? [])[0];
      if (!r) { console.log(`  ${ad.name}: no data`); continue; }
      const acts: Record<string,string> = {};
      for (const x of r.actions ?? []) acts[x.action_type] = x.value;
      const lpv = Number(acts["landing_page_view"] ?? 0);
      const lc = Number(r.inline_link_clicks ?? 0);
      console.log(`\n  ${ad.name}`);
      console.log(`    spend=$${r.spend} impr=${r.impressions} clicks=${r.clicks} linkClicks=${lc} LPV=${lpv} LPV/LC=${lc?((lpv/lc)*100).toFixed(1)+"%":"—"}`);
      const interesting = Object.entries(acts).filter(([k]) => /shop|onsite|catalog|view_content|checkout|cart|purchase|omni/i.test(k));
      if (interesting.length) console.log(`    SHOP/ONSITE ACTIONS: ${JSON.stringify(Object.fromEntries(interesting))}`);
      else console.log(`    (no shop/onsite actions)`);
    }
  }
})();
