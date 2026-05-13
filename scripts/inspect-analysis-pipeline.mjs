import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY } from "./env.mjs";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const WORKSPACE = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// Closed AI-tagged tickets in the last 5 days, broken down by date +
// last_analyzed_at state.
const cutoff = new Date(Date.now() - 5 * 86400000).toISOString();
const { data: tickets } = await admin
  .from("tickets")
  .select("id, status, tags, updated_at, last_analyzed_at, handled_by")
  .eq("workspace_id", WORKSPACE)
  .gte("updated_at", cutoff)
  .order("updated_at", { ascending: false })
  .limit(500);

const buckets = {};
for (const t of tickets || []) {
  const date = (t.updated_at || "").slice(0, 10);
  if (!buckets[date]) buckets[date] = { closed_ai: 0, closed_ai_not_analyzed: 0, closed_other: 0, open: 0 };
  const isClosed = t.status === "closed";
  const isAi = (t.tags || []).includes("ai");
  if (!isClosed) buckets[date].open++;
  else if (isAi) {
    buckets[date].closed_ai++;
    const needs = !t.last_analyzed_at || new Date(t.last_analyzed_at) < new Date(t.updated_at);
    if (needs) buckets[date].closed_ai_not_analyzed++;
  } else buckets[date].closed_other++;
}
console.log("Tickets by updated_at date (last 5 days):");
for (const date of Object.keys(buckets).sort().reverse()) {
  const b = buckets[date];
  console.log(`  ${date}  closed-ai=${b.closed_ai} (${b.closed_ai_not_analyzed} need analysis)  closed-other=${b.closed_other}  open=${b.open}`);
}

// Existing ticket_analyses count per UTC day
console.log("\nticket_analyses count per UTC day:");
for (let i = 0; i < 5; i++) {
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
  console.log(`  ${date}  ${count}`);
}
