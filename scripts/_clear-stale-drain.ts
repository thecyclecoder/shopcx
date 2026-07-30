import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const a=createAdminClient();
  const { data:before }=await a.from("worker_controls").select("*").eq("box_id","box").maybeSingle();
  console.log("before:", JSON.stringify(before));
  if(!(before as any)?.drain_for_update){ console.log("no active drain — nothing to clear"); return; }
  const { error }=await a.from("worker_controls").update({ drain_for_update:false, updated_at:new Date().toISOString() }).eq("box_id","box");
  if(error){ console.error("CLEAR FAILED:", error.message); process.exit(1); }
  const { data:after }=await a.from("worker_controls").select("drain_for_update,requested_at_sha").eq("box_id","box").maybeSingle();
  console.log("after:", JSON.stringify(after), "→ drain cleared; box will resume claiming next tick");
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
