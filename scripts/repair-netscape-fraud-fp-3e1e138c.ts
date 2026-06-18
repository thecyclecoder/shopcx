/**
 * Fraud case 3e1e138c-d991-4be5-bc26-325341cd93de — FALSE POSITIVE remediation.
 *
 * The `email_domain_velocity` rule fired on 4 unrelated, long-time customers who
 * merely share the legacy freemail domain @netscape.net (omitted from
 * FREEMAIL_DOMAINS in src/lib/fraud-detector.ts). The case was confirmed_fraud
 * 2026-06-18 16:15 and actioned: all 4 portal-banned, 4 subs cancelled, 1 order
 * refunded. These are real customers (29 / 15 / 8 / 5 lifetime orders, back to 2024,
 * across AZ/MI/MO/CA). No account links were created (customer_links empty).
 *
 * This script reverses the safe, fully-reversible harm:
 *   1. Un-ban all 4 (portal_banned → false, clear stamp).
 *   2. Reactivate the 4 fraud-cancelled subs (resume → status=ACTIVE).
 *      All 4 have FUTURE next_billing_date → no immediate charge on reactivation.
 *      Pre-existing cancel 28190769325 (Patricia, 2026-04-13) is LEFT ALONE.
 *   3. Report SC132897 (Linda) refund/cancel state — NOT auto-reversed (re-billing
 *      a customer is a judgment call; surface it for Dylan).
 *
 * Run: npx tsx scripts/repair-netscape-fraud-fp-3e1e138c.ts        (dry run, default)
 *      npx tsx scripts/repair-netscape-fraud-fp-3e1e138c.ts --exec (perform changes)
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

const CUSTOMERS = [
  { id: "6eefa4f7-ae42-423a-b8e7-dd4c37f12f41", name: "Janine Jedding" },
  { id: "4fcb2e2a-1dbf-4983-8f2e-b322f94d939f", name: "Linda West" },
  { id: "57db7d45-7e80-4512-b36e-2b2dd5a26a1d", name: "Patricia Forrester" },
  { id: "38016ab9-6cb8-4f06-bfb1-0323dce870ed", name: "Nestor Mondok" },
];
// Subs cancelled by the fraud flow today (16:04–16:15). All future next-bill.
const SUBS_TO_REACTIVATE = ["31315165357", "27837235373", "34561294509", "27877703853"];

async function main() {
  console.log(EXEC ? "=== EXEC MODE — performing changes ===\n" : "=== DRY RUN (pass --exec to apply) ===\n");

  // ── 1. Un-ban ──
  console.log("[1] UN-BAN");
  for (const c of CUSTOMERS) {
    const { data: before } = await admin.from("customers")
      .select("portal_banned, portal_banned_at").eq("id", c.id).single();
    console.log(`  ${c.name}: portal_banned=${before?.portal_banned}`);
    if (EXEC) {
      const { error } = await admin.from("customers").update({
        portal_banned: false, portal_banned_at: null, portal_banned_by: null,
        updated_at: new Date().toISOString(),
      }).eq("id", c.id).eq("workspace_id", WS);
      console.log(error ? `    ✗ ${error.message}` : "    ✓ un-banned");
    }
  }

  // ── 2. Reactivate subs ──
  console.log("\n[2] REACTIVATE SUBSCRIPTIONS");
  const { appstleSubscriptionAction } = await import("../src/lib/appstle");
  for (const contractId of SUBS_TO_REACTIVATE) {
    const { data: sub } = await admin.from("subscriptions")
      .select("id, customer_id, status, next_billing_date").eq("shopify_contract_id", contractId)
      .eq("workspace_id", WS).maybeSingle();
    const past = sub?.next_billing_date ? new Date(sub.next_billing_date) < new Date("2026-06-18") : false;
    console.log(`  contract ${contractId}: status=${sub?.status} next=${sub?.next_billing_date}${past ? " ⚠ PAST — would bill immediately" : ""}`);
    if (EXEC) {
      const r = await appstleSubscriptionAction(WS, contractId, "resume");
      console.log(r.success ? "    ✓ reactivated → ACTIVE" : `    ✗ ${r.error}`);
    }
  }

  // ── 3. Report refunded order (NOT auto-reversed) ──
  console.log("\n[3] REFUND DAMAGE (manual decision — NOT touched by this script)");
  const { data: ord } = await admin.from("orders")
    .select("order_number, financial_status, fulfillment_status, created_at")
    .eq("order_number", "SC132897").maybeSingle();
  console.log(`  SC132897 (Linda West): financial=${ord?.financial_status} fulfillment=${(ord as Record<string, unknown>)?.fulfillment_status ?? "n/a"}`);
  console.log("  → If cancelled+restocked, Linda never receives this order. Decide: re-place order, re-bill, or leave as goodwill.");

  console.log(`\n${EXEC ? "DONE." : "Dry run complete. Re-run with --exec to apply."}`);
  console.log("Note: fraud case status NOT changed here — handle case dismissal + freemail-list fix separately.");
}
main().catch(e => { console.error("✗ FAILED:", e); process.exit(1); });
