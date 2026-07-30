import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getTestingResults } from "../src/lib/ads/testing-results-sdk";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const admin=createAdminClient();
  // 1) CROWN/KILL AUDIT
  const res:any = await getTestingResults(admin, WS);
  console.log("=== CROWN/KILL AUDIT (per product → test rows) ===");
  const actions:{product:string,adset:string,verdict:string,detail:string}[]=[];
  for(const g of (res.products||[])){
    console.log(`\n▸ ${g.productTitle} (acct ${g.metaAccountName||g.metaAccountId?.slice?.(0,8)}) — ${g.rows?.length||0} tests, activeCount=${g.activeCount}`);
    for(const r of (g.rows||[])){
      const cac = r.cacCents!=null ? `$${(r.cacCents/100).toFixed(0)}` : "—";
      const spend=`$${(r.spendCents/100).toFixed(0)}`;
      console.log(`   [${r.tier}] ${r.active?"ACTIVE":"paused"} spend=${spend} purch=${r.purchases} ATC=${r.addToCart} CAC=${cac} ${r.adsetName?.slice(0,30)||""}`);
      if(r.tier==="crown" && r.active) actions.push({product:g.productTitle,adset:r.adsetName||r.adsetId,verdict:"CROWN",detail:`${r.purchases} purch @ ${cac}, ${spend}`});
      if(r.tier==="dud" && r.active) actions.push({product:g.productTitle,adset:r.adsetName||r.adsetId,verdict:"PAUSE(dud)",detail:`${spend} spend, ${r.purchases} purch`});
    }
  }
  console.log("\n=== SHOULD-HAPPEN ACTIONS ===");
  if(!actions.length) console.log("  none — no ACTIVE crown/dud right now");
  for(const a of actions) console.log(`  ${a.verdict}: ${a.product} / ${a.adset} (${a.detail})`);

  // 3) DAHLIA BIN CHECK (archived-excluded via listReadyToTest per product)
  console.log("\n=== DAHLIA BIN DEPTH (floor 4) ===");
  const products = (res.products||[]).map((g:any)=>({id:g.productId,title:g.productTitle}));
  for(const p of products){
    const {readyToTest}=await listReadyToTest(admin,{workspaceId:WS,productId:p.id});
    const flag = readyToTest.length<4 ? `⚠️ ${readyToTest.length}/4 (deficit ${4-readyToTest.length})` : `✓ ${readyToTest.length}/4`;
    console.log(`   ${p.title}: ${flag}`);
  }

  // 2) DID BIANCA ACT? recent media-buyer activity
  console.log("\n=== BIANCA RECENT ACTIVITY (24h) ===");
  const since=new Date(Date.now()-24*3600*1000).toISOString();
  const {data:acts}=await admin.from("director_activity").select("action_kind,reason,created_at")
    .eq("workspace_id",WS).like("action_kind","%media_buyer%").gte("created_at",since).order("created_at",{ascending:false}).limit(10);
  for(const a of (acts||[]) as any[]) console.log(`   ${a.created_at?.slice(5,16)} ${a.action_kind}: ${String(a.reason||"").replace(/\n/g," ").slice(0,90)}`);
  // policy mode
  const {data:pol}=await admin.from("iteration_policies").select("mode,status").eq("workspace_id",WS).eq("status","active").limit(1);
  console.log("   policy mode:", JSON.stringify(pol));
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR:",String(e).slice(0,300));process.exit(1);});
