#!/usr/bin/env node
/**
 * One-time migration: fix active subscriptions with next_billing_date too far out.
 *   - 90+ days out → set to today
 *   - 60–90 days out → set to 60 days from today
 *
 * Uses Appstle API (subscription-contracts-update-billing-date) + updates local Supabase.
 *
 * Usage:
 *   node scripts/fix-billing-dates.mjs              # dry run (default)
 *   node scripts/fix-billing-dates.mjs --execute     # actually run
 */

import { createClient } from "@supabase/supabase-js";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, ENCRYPTION_KEY } from "./env.mjs";

const DRY_RUN = !process.argv.includes("--execute");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ── Crypto (matches src/lib/crypto.ts) ──
function decrypt(encrypted) {
  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  const [ivHex, tagHex, ciphertextHex] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const ciphertext = Buffer.from(ciphertextHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

// ── Appstle API key cache ──
const appstleKeyCache = {};
async function getAppstleApiKey(workspaceId) {
  if (appstleKeyCache[workspaceId]) return appstleKeyCache[workspaceId];
  const { data: ws } = await supabase
    .from("workspaces")
    .select("appstle_api_key_encrypted")
    .eq("id", workspaceId)
    .single();
  if (!ws?.appstle_api_key_encrypted) throw new Error(`No Appstle key for workspace ${workspaceId}`);
  const key = decrypt(ws.appstle_api_key_encrypted);
  appstleKeyCache[workspaceId] = key;
  return key;
}

// ── Main ──
async function main() {
  const now = new Date();
  const sixtyDaysOut = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
  const ninetyDaysOut = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

  const tomorrowStr = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const sixtyDaysStr = sixtyDaysOut.toISOString();

  console.log(`\n${DRY_RUN ? "🔍 DRY RUN" : "🚀 EXECUTING"} — Fix billing dates`);
  console.log(`Tomorrow (90+ target): ${tomorrowStr.slice(0, 10)}`);
  console.log(`60 days out target: ${sixtyDaysStr.slice(0, 10)}`);
  console.log(`Cutoff for 90+ days: ${ninetyDaysOut.toISOString().slice(0, 10)}\n`);

  // Fetch all active subs with next_billing_date > 60 days from now
  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select("id, workspace_id, shopify_contract_id, next_billing_date, customer_id")
    .eq("status", "active")
    .gt("next_billing_date", sixtyDaysOut.toISOString());

  if (error) {
    console.error("Failed to fetch subscriptions:", error.message);
    process.exit(1);
  }

  console.log(`Found ${subs.length} active subscriptions with billing date > 60 days out\n`);

  // Split into two groups
  const group90Plus = subs.filter(s => new Date(s.next_billing_date) > ninetyDaysOut);
  const group60to90 = subs.filter(s => new Date(s.next_billing_date) <= ninetyDaysOut);

  console.log(`  90+ days out → set to today: ${group90Plus.length}`);
  console.log(`  60-90 days out → set to 60 days: ${group60to90.length}`);
  console.log(`  Total API calls: ${group90Plus.length + group60to90.length}\n`);

  let success = 0;
  let failed = 0;

  async function updateBillingDate(sub, newDate, label) {
    const contractId = sub.shopify_contract_id;
    const oldDate = sub.next_billing_date?.slice(0, 10);
    const newDateShort = newDate.slice(0, 10);

    if (DRY_RUN) {
      console.log(`  [DRY] contract ${contractId}: ${oldDate} → ${newDateShort} (${label})`);
      success++;
      return;
    }

    try {
      const apiKey = await getAppstleApiKey(sub.workspace_id);
      const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-date?contractId=${contractId}&rescheduleFutureOrder=true&nextBillingDate=${encodeURIComponent(newDate)}`;

      const res = await fetch(url, {
        method: "PUT",
        headers: { "X-API-Key": apiKey },
      });

      if (!res.ok && res.status !== 204) {
        const text = await res.text();
        console.error(`  [FAIL] contract ${contractId}: HTTP ${res.status} — ${text}`);
        failed++;
        return;
      }

      // Update local DB
      await supabase
        .from("subscriptions")
        .update({ next_billing_date: newDate, updated_at: new Date().toISOString() })
        .eq("id", sub.id);

      console.log(`  [OK] contract ${contractId}: ${oldDate} → ${newDateShort} (${label})`);
      success++;
    } catch (err) {
      console.error(`  [FAIL] contract ${contractId}: ${err.message}`);
      failed++;
    }
  }

  // Process 90+ days group → tomorrow (Appstle requires future date)
  for (const sub of group90Plus) {
    await updateBillingDate(sub, tomorrowStr, "90+ → tomorrow");
  }

  // Process 60-90 days group → 60 days out
  for (const sub of group60to90) {
    await updateBillingDate(sub, sixtyDaysStr, "60-90 → 60d");
  }

  console.log(`\nDone. Success: ${success}, Failed: ${failed}`);
  if (DRY_RUN) console.log("Run with --execute to apply changes.");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
