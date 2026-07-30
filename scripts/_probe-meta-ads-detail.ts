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
const ACCTS = ["act_196487894712827"]; // Superfood Tabs
(async () => {
  const admin = createAdminClient();
  const { data: ws } = await admin.from("workspaces").select("id,name").limit(20);
  let token: string | null = null;
  for (const w of ws ?? []) { token = await getMetaUserToken(w.id); if (token) break; }
  if (!token) throw new Error("no token");

  // find every account with active ads
  const accts = await g("me/adaccounts", token, { fields: "id,name" });
  for (const a of accts.data ?? []) {
    const ads = await g(`${a.id}/ads`, token, {
      fields: "id,name,effective_status,creative{id,object_story_spec,asset_feed_spec,effective_object_story_id,object_type,url_tags}",
      limit: "50",
    });
    const active = (ads.data ?? []).filter((x: any) => x.effective_status === "ACTIVE");
    if (!active.length) continue;
    console.log(`\n\n########## ${a.name} (${a.id}) — ${active.length} ACTIVE ads ##########`);
    for (const ad of active) {
      const oss = ad.creative?.object_story_spec ?? {};
      const link = oss.link_data?.link ?? oss.video_data?.call_to_action?.value?.link ?? "(none)";
      const cta = oss.link_data?.call_to_action?.type ?? oss.video_data?.call_to_action?.type ?? "(none)";
      console.log(`\n  AD: ${ad.name}`);
      console.log(`    link=${link}`);
      console.log(`    cta=${cta}  object_type=${ad.creative?.object_type}  url_tags=${ad.creative?.url_tags ?? "(none)"}`);
      if (oss.link_data?.child_attachments) console.log(`    !! child_attachments (catalog/carousel)`);
      if (ad.creative?.asset_feed_spec?.link_urls) console.log(`    afs.link_urls=${JSON.stringify(ad.creative.asset_feed_spec.link_urls)}`);
    }
    // insights
    const ins = await g(`${a.id}/insights`, token, {
      fields: "ad_name,spend,impressions,inline_link_clicks,actions,cost_per_action_type",
      level: "ad", date_preset: "maximum", limit: "50",
    });
    console.log(`\n  --- INSIGHTS (maximum) ---`);
    for (const r of ins.data ?? []) {
      const lpv = (r.actions ?? []).find((x: any) => x.action_type === "landing_page_view")?.value ?? 0;
      const lc = r.inline_link_clicks ?? 0;
      const rate = lc > 0 ? ((Number(lpv)/Number(lc))*100).toFixed(1) + "%" : "—";
      console.log(`    ${r.ad_name}: spend=$${r.spend} linkClicks=${lc} LPV=${lpv} LPV/LC=${rate}`);
    }
  }
})();
