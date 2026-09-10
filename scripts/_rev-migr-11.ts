import { loadEnv } from "./_bootstrap";
loadEnv();
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const admin = createAdminClient();
  const { data, error } = await admin.from("appstle_call_log").select("*").ilike("url", "%update-status%").order("created_at",{ascending:false}).limit(5);
  if (error) { console.log("call log err", error.message); }
  else console.log("update-status calls:", data?.length, JSON.stringify((data??[]).map((d:any)=>({u:d.url?.slice(0,140), s:d.status_code ?? d.status, at:d.created_at})), null, 1));
  const { data: d2 } = await admin.from("appstle_call_log").select("url,created_at").ilike("url","%status=CANCELLED%").limit(5);
  console.log("CANCELLED via update-status ever logged:", d2?.length ?? 0);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
