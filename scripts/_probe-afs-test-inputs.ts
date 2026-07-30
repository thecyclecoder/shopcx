import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken } from "../src/lib/meta-ads";
import { metaGraphRequest } from "../src/lib/meta/api";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  const token=await getMetaUserToken(WS); if(!token) throw new Error("no token");
  // Amazing Coffee product + cohort
  const { data:prod } = await admin.from("products").select("id,title,handle").ilike("title","%Amazing Coffee%").limit(1).maybeSingle();
  console.log("product:", JSON.stringify(prod));
  const { data:coh } = await admin.from("media_buyer_test_cohorts")
    .select("test_meta_campaign_id,default_meta_account_id,default_meta_page_id,default_meta_instagram_user_id,meta_ad_account_id")
    .eq("workspace_id",WS).eq("product_id",(prod as any)?.id).maybeSingle();
  console.log("cohort:", JSON.stringify(coh));
  // live adsets under the campaign
  const cid=(coh as any)?.test_meta_campaign_id;
  const adsets:any = await metaGraphRequest(token, `/${cid}/adsets`, { fields:"id,name,effective_status", limit:"10" });
  console.log("adsets under campaign:", JSON.stringify((adsets.data||[]).map((a:any)=>({id:a.id,name:a.name,st:a.effective_status}))));
  // 5 static image urls from our library
  const { data:imgs } = await admin.from("ad_videos").select("static_jpg_url").eq("workspace_id",WS).eq("media_kind","static").not("static_jpg_url","is",null).limit(8);
  console.log("static image urls:", JSON.stringify((imgs||[]).map((i:any)=>i.static_jpg_url)));
  // a destination url
  const { data:camp } = await admin.from("ad_campaigns").select("landing_url").eq("workspace_id",WS).eq("product_id",(prod as any)?.id).not("landing_url","is",null).limit(1).maybeSingle();
  console.log("landing_url:", (camp as any)?.landing_url, " handle-fallback:", `https://superfoods.com/products/${(prod as any)?.handle}`);
})().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
