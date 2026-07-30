import { loadEnv } from "./_bootstrap"; loadEnv();
import { inngest } from "@/lib/inngest/client";
import { getMetaUserToken } from "@/lib/meta-ads";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906", CAMP="120250066504550326";
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const ts=()=>new Date().toISOString().slice(11,19);
async function snap(t:string){const r=await fetch(`https://graph.facebook.com/v21.0/${CAMP}/adsets?fields=id&limit=50&access_token=${encodeURIComponent(t)}`);const j=await r.json();return new Set((j.data||[]).map((s:any)=>s.id));}
async function main(){
  const t=await getMetaUserToken(WS); if(!t)return console.log("no token");
  const before=await snap(t);
  await inngest.send({name:"growth/media-buyer-cadence-sweep",data:{workspace_id:WS,trigger:"manual-ceo-tabs-retry"}});
  console.log(`[${ts()}] re-fired Bianca (Tabs had ${before.size} adsets) — watching…`);
  for(let i=0;i<25;i++){
    await sleep(60000);
    const r=await fetch(`https://graph.facebook.com/v21.0/${CAMP}/adsets?fields=id,name,effective_status,ads.limit(1){id,effective_status,creative{asset_feed_spec{titles,bodies,images}}}&limit=50&access_token=${encodeURIComponent(t)}`);
    const j=await r.json();
    const news=(j.data||[]).filter((s:any)=>!before.has(s.id));
    if(news.length){ console.log(`\n════════ ${news.length} NEW SUPERFOOD TABS AD SET(S) ════════`);
      for(const s of news){const ad=s.ads?.data?.[0];const afs=ad?.creative?.asset_feed_spec;
        console.log(`  "${(s.name||"").slice(0,44)}" — ${s.ads?.data?.length?`ad ${ad.effective_status} [titles=${afs?.titles?.length} bodies=${afs?.bodies?.length} images=${afs?.images?.length}]`:"⚠️ EMPTY"}`);}
      console.log("════════ END ════════"); return; }
    if(i%4===0) console.log(`[${ts()}] waiting…`);
  }
  console.log("\n════════ still no new Tabs ad sets — likely an adset-match/temperature routing skip, will dig ════════");
}
main().then(()=>process.exit(0)).catch(e=>{console.error("threw:",e instanceof Error?e.message:String(e));process.exit(1);});
