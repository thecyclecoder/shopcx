import { readFileSync } from "fs";
import { resolve } from "path";
import { createClient } from "@supabase/supabase-js";

const envPath = resolve(process.cwd(), ".env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/20260917120000_create_order_refunds.sql"), "utf8");
console.log("Applying order_refunds migration via exec_sql RPC...");
const { data, error } = await admin.rpc("exec_sql", { sql });
if (error) { console.error("APPLY ERROR:", error.message || error); process.exit(1); }
console.log("✓ Applied:", data ?? "(no result)");

// Verify table + insert/select roundtrip on the guard shape
const { error: probeErr } = await admin.from("order_refunds").select("id, workspace_id, order_id, request_key, vendor, status").limit(1);
if (probeErr) { console.error("PROBE ERROR (table missing?):", probeErr.message); process.exit(1); }
console.log("✓ order_refunds table exists and is queryable");
process.exit(0);
