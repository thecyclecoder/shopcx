import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async()=>{
  const a=createAdminClient();
  const { data:j }=await a.from("agent_jobs").select("id,status,kind,spec_slug,pending_actions,questions,error,instructions,created_at").eq("id","ead0cac8-515b-4c41-9097-eec96599edc0").maybeSingle();
  console.log("job status:", j?.status, "kind:", j?.kind, "created:", (j as any)?.created_at);
  console.log("pending_actions:", JSON.stringify((j as any)?.pending_actions,null,1));
  console.log("questions:", JSON.stringify((j as any)?.questions,null,1)?.slice(0,600));
  console.log("error:", (j as any)?.error?.slice(0,300));
  // is the cold-offer-gate sibling on main?
  const r=await a.from("agent_jobs").select("status").eq("workspace_id",WS).eq("kind","build").eq("spec_slug","dahlia-audience-temperature-marking-and-cold-offer-gate").order("updated_at",{ascending:false}).limit(1);
  console.log("\ncold-offer-gate sibling latest build status:", (r.data as any)?.[0]?.status);
})().then(()=>process.exit(0));
