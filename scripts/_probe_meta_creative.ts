import { loadEnv } from "./_bootstrap";
loadEnv();
import { getMetaUserToken } from "../src/lib/meta-ads";
import { metaGraphRequest } from "../src/lib/meta/api";
async function main(){
  const token = await getMetaUserToken("fdc11e10-b89f-4989-8b73-ed6526c4d906");
  if(!token){console.log("no token");return;}
  // a known live Coffee test ad set -> get its ad -> creative. Use the adset "Dahlia · Amazing Coffee · comp".
  // First list ads in that adset via insights meta_ad_id? Use meta_ads table.
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const { data: pj } = await admin.from("ad_publish_jobs").select("meta_ad_id, ad_name").eq("workspace_id","fdc11e10-b89f-4989-8b73-ed6526c4d906").not("meta_ad_id","is",null).ilike("ad_name","%Amazing Coffee%").order("created_at",{ascending:false}).limit(1);
  const adId = (pj?.[0] as any)?.meta_ad_id;
  console.log("ad:", adId, (pj?.[0] as any)?.ad_name);
  if(!adId) return;
  const r:any = await metaGraphRequest(token, `/${adId}`, { fields: "name,creative{id,thumbnail_url,image_url,object_story_spec,asset_feed_spec}" });
  console.log(JSON.stringify(r, null, 2).slice(0, 1800));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,300));process.exit(1);});
