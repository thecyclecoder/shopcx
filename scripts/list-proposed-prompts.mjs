import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const W = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

// First probe schema
const { data: sample } = await sb.from("sonnet_prompts").select("*").eq("workspace_id", W).limit(1);
console.log("Columns:", Object.keys(sample?.[0] || {}));

// Get all rules, grouped by status
const { data: all, error } = await sb.from("sonnet_prompts").select("id, title, category, status, enabled, sort_order, derived_from_ticket_id, proposed_at, reviewed_at").eq("workspace_id", W).order("status", { ascending: true }).order("sort_order", { ascending: true });
if (error) { console.error(error); process.exit(1); }

const byStatus = new Map();
for (const r of all || []) {
  const s = r.status || "(null)";
  if (!byStatus.has(s)) byStatus.set(s, []);
  byStatus.get(s).push(r);
}
console.log("\n=== Status breakdown ===");
for (const [s, arr] of byStatus) console.log(`  ${s}: ${arr.length}`);

console.log("\n=== Proposed rules ===");
for (const r of byStatus.get("proposed") || []) {
  console.log(`  ${r.id}  [${r.category}]  ${r.title}`);
  console.log(`    derived_from_ticket=${r.derived_from_ticket_id || "-"}  proposed=${r.proposed_at || "-"}`);
}
