import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
async function main(){
  const admin = createAdminClient();
  // distinct loop_ids with latest beat
  const { data } = await admin.from("loop_heartbeats")
    .select("loop_id, ran_at")
    .order("ran_at", { ascending: false })
    .limit(2000);
  const latest = new Map<string, string>();
  const counts = new Map<string, number>();
  for (const r of (data||[]) as any[]) {
    if (!latest.has(r.loop_id)) latest.set(r.loop_id, r.ran_at);
    counts.set(r.loop_id, (counts.get(r.loop_id)||0)+1);
  }
  const now = Date.now();
  const rows = [...latest.entries()].map(([id, ts]) => ({ id, ts, ageMin: Math.round((now - new Date(ts).getTime())/60000), n: counts.get(id) }));
  rows.sort((a,b)=>a.ageMin-b.ageMin);
  console.log("=== loops mentioning test/ad/meta/insight/scorecard/creative ===");
  for (const r of rows.filter(r=>/test|ad|meta|insight|scorecard|creative|dahlia|bianca|buyer/i.test(r.id)))
    console.log(`  ${r.ageMin.toString().padStart(5)}min ago  n=${r.n}  ${r.id}`);
  console.log("\n=== ALL loops (freshest first) ===");
  for (const r of rows) console.log(`  ${r.ageMin.toString().padStart(6)}min  ${r.id}`);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
