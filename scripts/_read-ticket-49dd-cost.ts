import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const TID = "49ddd6c4-9894-4474-b925-fffe19a175c8";
(async () => {
  const db = createAdminClient();
  // token usage
  const { data: tok } = await db.from("ai_token_usage").select("*").eq("ticket_id", TID).order("created_at",{ascending:true});
  console.log("=== AI TOKEN USAGE rows:", (tok||[]).length, "===");
  const byPurpose: Record<string, {calls:number, in:number, out:number, cost:number, model:Set<string>}> = {};
  let total = 0;
  for (const r of tok||[]) {
    const p = (r as any).purpose || "?";
    const model = (r as any).model || "?";
    const inTok = (r as any).input_tokens ?? (r as any).prompt_tokens ?? 0;
    const outTok = (r as any).output_tokens ?? (r as any).completion_tokens ?? 0;
    const cost = Number((r as any).cost_usd ?? (r as any).cost ?? 0);
    total += cost;
    byPurpose[p] = byPurpose[p] || {calls:0,in:0,out:0,cost:0,model:new Set()};
    byPurpose[p].calls++; byPurpose[p].in+=inTok; byPurpose[p].out+=outTok; byPurpose[p].cost+=cost; byPurpose[p].model.add(model);
  }
  for (const [p,v] of Object.entries(byPurpose).sort((a,b)=>b[1].cost-a[1].cost)) {
    console.log(`  ${p}: ${v.calls} calls | in ${v.in} out ${v.out} | $${v.cost.toFixed(3)} | ${[...v.model].join(",")}`);
  }
  console.log("  TOTAL: $" + total.toFixed(3));
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
