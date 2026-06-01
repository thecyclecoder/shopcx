import { readFileSync } from "fs";
import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { error } = await admin.from("workspaces").update({ avalara_enabled: true }).eq("id", WS);
  if (error) throw error;
  const { data } = await admin
    .from("workspaces")
    .select("avalara_enabled, avalara_environment, avalara_account_id, avalara_company_code, avalara_default_tax_code")
    .eq("id", WS).single();
  console.log("✓ Avalara enabled:", JSON.stringify(data, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
