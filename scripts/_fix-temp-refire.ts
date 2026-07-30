import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "@/lib/supabase/admin";
import { inngest } from "@/lib/inngest/client";
import { getMetaUserToken } from "@/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", CAMP="120250066504550326";
const OV=["301f5120-b035-438d-b317-f844b942c260","38dc8a40-3a4d-4296-be27-b457333dd89f"];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const ts=()=>new Date().toISOString().slice(11,19);
async function snap(t:string){const r=await fetch(`https://graph.facebook.com/v21.0/${CAMP}/adsets?fields=id&limit=50&access_token=${encodeURIComponent(t)}`);const j=await r.json();return new Set((j.data||[]).map((s:any)=>s.id));}
async function main(){const a=createAdminClient();
  const {error}=await a.from("ad_campaigns").update({audience_temperature:"cold",updated_at:new Date().toISOString()}).in("id",OV);
  const {data:chk}=await a.from("ad_campaigns").select("id,audience_temperature").in("id",OV) as any;
  console.log("set temp=cold:", (chk||[]).map((c:any)=>`${c.id.slice(0,8)}=${c.audience_temperature}`).join(", "), error?`ERR ${error.message}`:"✓");
  const t=await getMetaUserToken(WS); const before=await snap(t!);
  await inngest.send({name:"growth/media-buyer-cadence-sweep",data:{workspace_id:WS,trigger:"manual-ceo-temp-fix"}});
  console.log(`[${ts()}] re-fired Bianca (Tabs had ${before.size} adsets) — watching…`);
  for(let i=0;i<22;i++){ await sleep(60000);
    const r=await fetch(`https://graph.facebook.com/v21.0/${CAMP}/adsets?fields=id,name,ads.limit(1){effective_status,creative{asset_feed_spec{titles,bodies,images}}}&limit=50&access_token=${encodeURIComponent(t!)}`);
    const j=await r.json(); const news=(j.data||[]).filter((s:any)=>!before.has(s.id));
    if(news.length){ console.log(`\n════════ ${news.length} NEW TABS AD SET(S) ════════`);
      for(const s of news){const ad=s.ads?.data?.[0];const afs=ad?.creative?.asset_feed_spec; console.log(`  "${(s.name||"").slice(0,44)}" — ${ad?`${ad.effective_status} [titles=${afs?.titles?.length} bodies=${afs?.bodies?.length} images=${afs?.images?.length}]`:"⚠️ EMPTY"}`);}
      console.log("════════ END ════════"); return; }
    if(i%4===0) console.log(`[${ts()}] waiting…`);
  }
  console.log("\n════════ still nothing — temp wasn't it; will dig further ════════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("threw:",e instanceof Error?e.message:String(e));process.exit(1);});
