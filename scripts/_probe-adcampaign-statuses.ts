import { loadEnv } from "./_bootstrap"; loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
(async () => {
  const admin = createAdminClient();
  const { data } = await admin.from("ad_campaigns").select("status").eq("workspace_id", WS).limit(3000);
  const m = new Map<string, number>();
  for (const r of (data||[]) as any[]) m.set(r.status ?? "null", (m.get(r.status ?? "null")||0)+1);
  console.log([...m.entries()].sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join("  "));
})().then(()=>process.exit(0));
