/**
 * Operational script — DESTRUCTIVE.
 *
 * Reads /tmp/reseller-impact-report.json (produced by
 * scripts/reseller-impact-report.ts) and:
 *
 *   1. Cancels every active/paused subscription tied to a reseller
 *      via Appstle (cancellationFeedback="fraud", note attributing
 *      ShopCX). Logs each to fraud_action_log.
 *   2. Marks every customer profile as banned (banned=true,
 *      banned_at=now, banned_reason="Amazon reseller — reseller_id=...").
 *      Linked profiles too.
 *   3. Confirms the open fraud_case for each customer (status →
 *      'confirmed_fraud') so the orchestrator gate kicks in for any
 *      future inbound message.
 *
 * Run with --dry-run first to see what would happen:
 *   npx tsx scripts/cancel-and-ban-resellers.ts --dry-run
 *
 * Then run for real:
 *   npx tsx scripts/cancel-and-ban-resellers.ts --confirm
 *
 * Refuses to run without one of those flags.
 */
import { readFileSync } from "fs";

const envPath = "/Users/admin/Projects/shopcx/.env.local";
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq < 0) continue;
  const k = t.slice(0, eq);
  if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}

interface ReportEntry {
  workspace_id: string;
  reseller_id: string;
  reseller_name: string;
  address: string;
  matched_orders: Array<{ order_id: string; order_number: string; customer_id: string | null }>;
  customer_ids: string[];
  customer_emails: string[];
  active_subscriptions: Array<{
    subscription_id: string;
    shopify_contract_id: string | null;
    status: string;
    customer_id: string;
    customer_email: string | null;
  }>;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const confirm = args.includes("--confirm");
  if (!dryRun && !confirm) {
    console.error("Usage: tsx scripts/cancel-and-ban-resellers.ts --dry-run | --confirm");
    process.exit(1);
  }

  const report: ReportEntry[] = JSON.parse(readFileSync("/tmp/reseller-impact-report.json", "utf8"));
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { appstleSubscriptionAction } = await import("../src/lib/appstle");
  const admin = createAdminClient();

  console.log(`Mode: ${dryRun ? "DRY RUN" : "LIVE — destructive actions enabled"}`);
  console.log(`Resellers in report: ${report.length}`);
  const totalSubs = report.reduce((s, e) => s + e.active_subscriptions.length, 0);
  const totalCustomers = new Set(report.flatMap(e => e.customer_ids)).size;
  console.log(`Subscriptions to cancel: ${totalSubs}`);
  console.log(`Customer profiles to ban: ${totalCustomers}\n`);

  let subsCancelled = 0, subsFailed = 0;
  let customersBanned = 0;
  let casesConfirmed = 0;

  for (const entry of report) {
    console.log(`▶ ${entry.reseller_name}  ${entry.address}`);

    // 1. Cancel every active/paused subscription
    for (const sub of entry.active_subscriptions) {
      if (!sub.shopify_contract_id) {
        console.log(`  skip sub (no contract_id): ${sub.subscription_id.slice(0, 8)}`);
        continue;
      }
      if (dryRun) {
        console.log(`  [DRY] cancel sub ${sub.shopify_contract_id} for ${sub.customer_email || sub.customer_id.slice(0, 8)}`);
      } else {
        const result = await appstleSubscriptionAction(
          entry.workspace_id,
          sub.shopify_contract_id,
          "cancel",
          "fraud",
          "ShopCX (Amazon reseller)",
        );
        if (result.success) {
          subsCancelled++;
          console.log(`  ✓ cancelled ${sub.shopify_contract_id} (${sub.customer_email || sub.customer_id.slice(0, 8)})`);
          await admin.from("fraud_action_log").insert({
            workspace_id: entry.workspace_id,
            customer_id: sub.customer_id,
            subscription_id: sub.subscription_id,
            reseller_id: entry.reseller_id,
            action: "subscription_cancelled",
            metadata: { reason: "amazon_reseller", contract_id: sub.shopify_contract_id, cancelled_by: "reseller-impact-script" },
          });
        } else {
          subsFailed++;
          console.log(`  ✗ FAILED ${sub.shopify_contract_id}: ${result.error}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // 2. Ban every customer profile
    for (const custId of entry.customer_ids) {
      if (dryRun) {
        console.log(`  [DRY] ban customer ${custId.slice(0, 8)}`);
      } else {
        const { error } = await admin.from("customers").update({
          banned: true,
          banned_at: new Date().toISOString(),
          banned_reason: `Amazon reseller — reseller_id=${entry.reseller_id}`,
        }).eq("id", custId);
        if (!error) {
          customersBanned++;
          await admin.from("fraud_action_log").insert({
            workspace_id: entry.workspace_id,
            customer_id: custId,
            reseller_id: entry.reseller_id,
            action: "customer_banned",
            metadata: { reason: "amazon_reseller" },
          });
        }
      }
    }

    // 3. Confirm fraud cases for these customers so the orchestrator
    // gate kicks in. Only update cases that are 'open' or 'reviewing'
    // (don't downgrade dismissed → confirmed).
    if (entry.customer_ids.length && !dryRun) {
      const { data: cases } = await admin
        .from("fraud_cases")
        .select("id")
        .eq("workspace_id", entry.workspace_id)
        .overlaps("customer_ids", entry.customer_ids)
        .in("status", ["open", "reviewing"]);
      for (const c of cases || []) {
        await admin.from("fraud_cases").update({
          status: "confirmed_fraud",
          updated_at: new Date().toISOString(),
        }).eq("id", c.id);
        casesConfirmed++;
      }
    }
  }

  console.log("\n" + "═".repeat(60));
  console.log(`SUMMARY (${dryRun ? "DRY RUN" : "LIVE"})`);
  console.log("═".repeat(60));
  console.log(`Subscriptions cancelled:   ${subsCancelled}`);
  console.log(`Subscription failures:     ${subsFailed}`);
  console.log(`Customer profiles banned:  ${customersBanned}`);
  console.log(`Fraud cases confirmed:     ${casesConfirmed}`);
}
main().catch(e => { console.error(e); process.exit(1); });
