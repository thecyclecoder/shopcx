import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const admin=createAdminClient();
  const { data } = await admin.from("iteration_policies").select("*").eq("workspace_id",WS).order("created_at",{ascending:false}).limit(1);
  const p=data?.[0] as any;
  console.log("=== active policy: mode + kill signal knobs ===");
  for(const k of ["version","mode","trust_meta_reported_signal","roas_floor","pause_min_spend_cents","crown_max_cpa_cents","crown_min_purchases","hold_band_max_cpa_cents","max_test_spend_cents","early_trim_min_spend_cents","scale_up_roas_trigger"])
    console.log(`  ${k} = ${p?.[k]}`);
  // is skeptic v3 actually still active? (recommendation vs executed)
  console.log("\n=== recent kills on skeptic v3 adset 120252196709210184 (iteration_actions) ===");
  const { data: acts } = await admin.from("iteration_actions").select("action_type, level, created_at").eq("workspace_id",WS).eq("object_id","120252196709210184").order("created_at",{ascending:false}).limit(5);
  console.log(acts?.length? JSON.stringify(acts,null,1) : "  none — no executed pause action on this adset");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,200));process.exit(1);});
