import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// 1) What reports exist?
const { data: reports } = await admin
  .from("daily_analysis_reports")
  .select("date, analyzed_count, avg_score, created_at, updated_at, source")
  .eq("workspace_id", WORKSPACE)
  .order("date", { ascending: false })
  .limit(20);
console.log("Existing daily_analysis_reports rows:");
for (const r of reports || []) {
  console.log(
    `  date=${r.date} analyzed=${r.analyzed_count} avg=${r.avg_score} src=${r.source} created=${r.created_at} updated=${r.updated_at}`,
  );
}

// 2) How many ticket_analyses per UTC day in the last 7 days?
console.log("\nticket_analyses count per UTC day (last 7 days):");
for (let i = 0; i < 8; i++) {
  const d = new Date(Date.now() - i * 86400000);
  const date = d.toISOString().slice(0, 10);
  const dayStart = `${date}T00:00:00.000Z`;
  const dayEnd = new Date(new Date(dayStart).getTime() + 86400000).toISOString();
  const { count } = await admin
    .from("ticket_analyses")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", WORKSPACE)
    .gte("created_at", dayStart)
    .lt("created_at", dayEnd);
  console.log(`  ${date}  ${count} analyses`);
}
