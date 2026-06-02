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

const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/20260519180000_cart_drafts_source_handle.sql"), "utf8");
console.log("Applying migration via RPC...");
const { data, error } = await admin.rpc("exec_sql", { sql });
if (error) { console.error(error); process.exit(1); }
console.log("✓ Applied:", data || "(no result)");

// Verify
const { data: probe, error: probeErr } = await admin.from("cart_drafts").select("source_product_handle").limit(1);
if (probeErr) { console.error("probe error:", probeErr.message); process.exit(1); }
console.log("✓ Column exists, sample row:", probe?.[0] || "(no rows)");
