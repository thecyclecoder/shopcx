import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { getSpec } from "../src/lib/specs-table";
import { Client } from "pg";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  // 1) has the schema-drift fix spec actually built/merged?
  const s:any=await getSpec(WS,"media-buyer-schema-drift-meta-ads-spend-and-publish-job-campaign-id").catch(()=>null);
  console.log("schema-drift fix spec:", s?`status=${s.status??"(derived)"} phases=${(s.phases||[]).map((p:any)=>p.status).join(",")}`:"NOT FOUND");
  // 2) do the broken columns still not exist? (proves code is still broken until deploy)
  const c=new Client({connectionString:`postgres://postgres.urjbhjbygyxffrfkarqn:${process.env.SUPABASE_DB_PASSWORD}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`,ssl:{rejectUnauthorized:false}});
  await c.connect();
  for(const [t,col] of [["meta_ads","spend_cents"],["ad_publish_jobs","ad_campaign_id"],["agent_jobs","branch"],["spec_test_runs","branch"]]){
    const r=await c.query(`select 1 from information_schema.columns where table_schema='public' and table_name=$1 and column_name=$2`,[t,col]);
    console.log(`  ${t}.${col}: ${r.rows.length?"EXISTS":"MISSING ❌"}`);
  }
  await c.end();
})().then(()=>process.exit(0)).catch(e=>{console.error("ERR",String(e).slice(0,200));process.exit(1);});
