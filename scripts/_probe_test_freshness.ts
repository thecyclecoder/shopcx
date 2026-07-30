import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
// test accounts from cohorts
const ACCTS: Record<string,string> = {
  "2352876514967984":"Coffee&Creamer", "196487894712827":"Tabs",
  "1225019394502467":"creatine", "2395577783853111":"Ashwavana",
};
async function main(){
  const admin = createAdminClient();
  // map meta_account_id -> uuid
  const { data: accts } = await admin.from("meta_ad_accounts").select("id, meta_account_id, timezone").eq("workspace_id",WS);
  const now = new Date();
  const todayUTC = now.toISOString().slice(0,10);
  console.log(`now UTC: ${now.toISOString()}  todayUTC=${todayUTC}\n`);
  for (const a of (accts||[]) as any[]) {
    if (!ACCTS[a.meta_account_id]) continue;
    const { data: rows } = await admin.from("meta_insights_daily")
      .select("snapshot_date, updated_at, spend_cents")
      .eq("workspace_id",WS).eq("meta_ad_account_id",a.id).eq("level","adset")
      .order("snapshot_date",{ascending:false}).limit(400);
    const r = (rows||[]) as any[];
    const bySnap = new Map<string,{n:number,spend:number,maxUpd:string}>();
    for (const x of r){ const c=bySnap.get(x.snapshot_date)??{n:0,spend:0,maxUpd:""}; c.n++; c.spend+=x.spend_cents||0; if((x.updated_at||"")>c.maxUpd)c.maxUpd=x.updated_at; bySnap.set(x.snapshot_date,c); }
    const snaps=[...bySnap.entries()].sort((a,b)=>b[0].localeCompare(a[0])).slice(0,3);
    console.log(`${ACCTS[a.meta_account_id]} (${a.meta_account_id}) tz=${a.timezone}`);
    for(const [d,c] of snaps){
      const ageH = c.maxUpd? ((now.getTime()-new Date(c.maxUpd).getTime())/3600000).toFixed(1):"?";
      console.log(`   ${d}: ${c.n} adset-rows  $${(c.spend/100).toFixed(0)}  lastUpdated ${c.maxUpd?.slice(0,19)} (${ageH}h ago)`);
    }
    console.log(`   → today (${todayUTC}) present: ${bySnap.has(todayUTC)?"YES":"NO"}`);
  }
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
