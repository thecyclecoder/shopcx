import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
(async () => {
  const db = createAdminClient();
  const { data: j } = await db.from("agent_jobs").select("*").eq("id","f984a9fb-6eac-4518-ba29-c9db7f1eaa7d").maybeSingle();
  console.log("status:", (j as any).status, "| updated:", (j as any).updated_at);
  const p=(j as any).payload||{};
  const pa=p.pending_actions||[];
  console.log("pending_actions:", pa.length);
  for(const a of pa) console.log("  -", a.id, a.type, "decision=", a.decision||a.status||"(pending)", "| cmd:", (a.cmd||"").slice(0,60));
  // approvals log?
  for(const k of Object.keys(p)) if(/approv|decision|resolved/i.test(k)) console.log("  payload."+k+":", JSON.stringify(p[k]).slice(0,200));
  process.exit(0);
})().catch(e=>{console.error(e.message);process.exit(1);});
