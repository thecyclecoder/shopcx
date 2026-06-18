/**
 * Dismiss fraud case 3e1e138c as a false positive. The email_domain_velocity rule
 * fired on 4 unrelated long-time customers sharing the legacy freemail domain
 * @netscape.net (missing from the old FREEMAIL_DOMAINS seed; now fixed by vendoring
 * the full free-email-domains list). All actions were already reversed (un-banned,
 * subs reactivated, Linda's order re-placed as SC132899).
 *
 * Run with --exec to apply.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
import { createClient } from "@supabase/supabase-js";
const EXEC = process.argv.includes("--exec");
const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const CASE_ID = "3e1e138c-d991-4be5-bc26-325341cd93de";
const DYLAN_AUTH_USER = "89fc395f-cc52-4eac-8eef-ea902a956810"; // auth.users.id used on prior history rows
const REASON = "False positive — email_domain_velocity fired on 4 unrelated long-time customers sharing the legacy freemail domain @netscape.net (missing from FREEMAIL_DOMAINS seed; now fixed by vendoring the full free-email-domains list). All actions reversed: 4 un-banned, 4 subs reactivated, Linda West's refunded order re-placed as SC132899.";

async function main() {
  const { data: before } = await admin.from("fraud_cases")
    .select("status, orders_held, dismissal_reason").eq("id", CASE_ID).single();
  console.log("before:", JSON.stringify(before));
  if (!EXEC) { console.log("\nDRY RUN — pass --exec to dismiss.\nWould set status=dismissed, orders_held=false, dismissal_reason set."); return; }

  const { error } = await admin.from("fraud_cases").update({
    status: "dismissed",
    orders_held: false,
    dismissal_reason: REASON,
    resolution: "Dismissed — false positive (freemail domain). All fraud actions reversed.",
    review_notes: REASON,
  }).eq("id", CASE_ID).eq("workspace_id", WS);
  if (error) throw new Error(`update failed: ${error.message}`);
  console.log("  ✓ case dismissed + order hold cleared");

  const { error: histErr } = await admin.from("fraud_case_history").insert({
    case_id: CASE_ID, workspace_id: WS, user_id: DYLAN_AUTH_USER,
    action: "status_changed", old_value: "confirmed_fraud", new_value: "dismissed",
    notes: "Reclassified as false positive (freemail domain @netscape.net). Actions reversed.",
  });
  if (histErr) throw new Error(`history insert failed: ${histErr.message}`);
  console.log("  ✓ history row added");

  const { data: after } = await admin.from("fraud_cases")
    .select("status, orders_held, dismissal_reason").eq("id", CASE_ID).single();
  console.log("\nafter:", JSON.stringify(after));
}
main().catch(e => { console.error("✗ FAILED:", e); process.exit(1); });
