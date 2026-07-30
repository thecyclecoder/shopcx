import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{const a=createAdminClient();const {count}=await a.from("creative_skeletons").select("id",{count:"exact",head:true}).eq("workspace_id",WS);const {data}=await a.from("creative_skeletons").select("media_type").eq("workspace_id",WS);const v=(data||[]).filter((x:any)=>x.media_type==="video").length;console.log(`creative_skeletons: ${count} total (${(count||0)-v} static / ${v} video)`);})().then(()=>process.exit(0));
