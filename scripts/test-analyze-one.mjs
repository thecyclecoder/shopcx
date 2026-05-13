import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const cutoff = new Date(Date.now() - 3 * 86400000).toISOString();

const { data: tickets } = await admin
  .from("tickets")
  .select("id, status, tags, updated_at, last_analyzed_at, customer_id")
  .eq("workspace_id", WORKSPACE)
  .eq("status", "closed")
  .contains("tags", ["ai"])
  .gte("updated_at", cutoff)
  .order("updated_at", { ascending: false })
  .limit(20);

const needs = (tickets || []).filter(
  (t) =>
    !t.last_analyzed_at ||
    new Date(t.last_analyzed_at) < new Date(t.updated_at),
);

console.log(`Tickets matching cron filter: ${tickets?.length} total, ${needs.length} need analysis`);
console.log("\nFirst 5 needing analysis:");
for (const t of needs.slice(0, 5)) {
  console.log(`  id=${t.id} updated=${t.updated_at} last_analyzed=${t.last_analyzed_at}`);
}
