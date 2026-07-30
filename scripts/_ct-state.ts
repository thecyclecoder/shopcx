import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{const a=createAdminClient();const {data}=await a.from("agent_jobs").select("id,status,needs_attention_class").eq("workspace_id",WS).eq("kind","build").eq("spec_slug","control-tower-suppress-box-cron-freshness-during-worker-outa").order("updated_at",{ascending:false}).limit(1);const j=(data as any)?.[0];console.log("ct-suppress build:",j?.id?.slice(0,8),j?.status,j?.needs_attention_class||"");})().then(()=>process.exit(0));
