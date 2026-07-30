import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async()=>{
  const a=createAdminClient();
  const { data }=await a.from("worker_controls").select("*");
  console.log("worker_controls:", JSON.stringify(data));
  console.log("box RUNNING_SHA: c6a14b709");
})().then(()=>process.exit(0));
