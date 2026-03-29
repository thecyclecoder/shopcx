#!/usr/bin/env node
/**
 * One-time: Move stale billing dates to tomorrow, then fire dunning events.
 *
 * Usage:
 *   node scripts/dunning-stale-subs.mjs                # dry run
 *   node scripts/dunning-stale-subs.mjs --test-one     # move date + fire dunning for 1 sub
 *   node scripts/dunning-stale-subs.mjs --execute       # all 99
 */

import { createClient } from "@supabase/supabase-js";
import { createDecipheriv } from "crypto";
import { SUPABASE_URL, SUPABASE_SERVICE_KEY, ENCRYPTION_KEY, INNGEST_EVENT_KEY } from "./env.mjs";

const SUPABASE_KEY = SUPABASE_SERVICE_KEY;

const MODE = process.argv.includes("--execute") ? "execute" : process.argv.includes("--test-one") ? "test-one" : "dry";

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function decrypt(encrypted) {
  const key = Buffer.from(ENCRYPTION_KEY, "hex");
  const [ivHex, tagHex, ciphertextHex] = encrypted.split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(ciphertextHex, "hex")).toString("utf8") + decipher.final("utf8");
}

async function main() {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  console.log(`\n${MODE === "dry" ? "DRY RUN" : MODE === "test-one" ? "TEST ONE" : "EXECUTING ALL"}`);
  console.log(`Tomorrow: ${tomorrow.slice(0, 10)}\n`);

  // 1. Fetch stale active subs with customer data
  const { data: subs, error } = await supabase
    .from("subscriptions")
    .select("id, workspace_id, shopify_contract_id, shopify_customer_id, customer_id, next_billing_date, customers!inner(shopify_customer_id)")
    .eq("status", "active")
    .lt("next_billing_date", now.toISOString());

  if (error) { console.error("Query failed:", error.message); process.exit(1); }

  // Resolve shopify_customer_id from customers table if missing on sub
  for (const s of subs) {
    if (!s.shopify_customer_id) {
      s.shopify_customer_id = s.customers?.shopify_customer_id || null;
    }
  }

  console.log(`Found ${subs.length} stale active subscriptions\n`);

  // Get Appstle API key
  const workspaceId = subs[0]?.workspace_id;
  const { data: ws } = await supabase.from("workspaces").select("appstle_api_key_encrypted").eq("id", workspaceId).single();
  const appstleKey = decrypt(ws.appstle_api_key_encrypted);

  // Limit for test-one mode
  const toProcess = MODE === "test-one" ? subs.slice(0, 1) : subs;

  let dateSuccess = 0;
  let dateFailed = 0;
  let dunningFired = 0;
  let dunningFailed = 0;

  for (const sub of toProcess) {
    const contractId = sub.shopify_contract_id;
    const oldDate = sub.next_billing_date?.slice(0, 10);

    if (MODE === "dry") {
      console.log(`  [DRY] ${contractId}: ${oldDate} -> ${tomorrow.slice(0, 10)} + fire dunning`);
      dateSuccess++;
      dunningFired++;
      continue;
    }

    // Step A: Move billing date to tomorrow via Appstle
    try {
      const url = `https://subscription-admin.appstle.com/api/external/v2/subscription-contracts-update-billing-date?contractId=${contractId}&rescheduleFutureOrder=true&nextBillingDate=${encodeURIComponent(tomorrow)}`;
      const res = await fetch(url, { method: "PUT", headers: { "X-API-Key": appstleKey } });

      if (!res.ok && res.status !== 204) {
        const text = await res.text();
        console.error(`  [DATE FAIL] ${contractId}: ${res.status} — ${text}`);
        dateFailed++;
        continue; // Skip dunning if date move failed
      }

      // Update local DB
      await supabase.from("subscriptions").update({ next_billing_date: tomorrow, updated_at: now.toISOString() }).eq("id", sub.id);
      console.log(`  [DATE OK] ${contractId}: ${oldDate} -> ${tomorrow.slice(0, 10)}`);
      dateSuccess++;
    } catch (err) {
      console.error(`  [DATE FAIL] ${contractId}: ${err.message}`);
      dateFailed++;
      continue;
    }

    // Step B: Fire dunning/payment-failed Inngest event
    try {
      const inngestRes = await fetch("https://inn.gs/e/" + INNGEST_EVENT_KEY, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "dunning/payment-failed",
          data: {
            workspace_id: sub.workspace_id,
            shopify_contract_id: sub.shopify_contract_id,
            subscription_id: sub.id,
            customer_id: sub.customer_id,
            shopify_customer_id: sub.shopify_customer_id,
            billing_attempt_id: null,
            error_code: "stale_billing",
            error_message: "Stale billing date — manual dunning trigger",
          },
        }),
      });

      if (!inngestRes.ok) {
        const text = await inngestRes.text();
        console.error(`  [DUNNING FAIL] ${contractId}: ${inngestRes.status} — ${text}`);
        dunningFailed++;
      } else {
        console.log(`  [DUNNING OK] ${contractId}: event fired`);
        dunningFired++;
      }
    } catch (err) {
      console.error(`  [DUNNING FAIL] ${contractId}: ${err.message}`);
      dunningFailed++;
    }

    // Rate limit: 300ms between subs
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nDone.`);
  console.log(`  Billing dates: ${dateSuccess} ok, ${dateFailed} failed`);
  console.log(`  Dunning events: ${dunningFired} fired, ${dunningFailed} failed`);
  if (MODE === "dry") console.log("\nRun with --test-one to test 1, or --execute for all.");
  if (MODE === "test-one") console.log("\nCheck Inngest dashboard + dunning_cycles table to verify. Then run with --execute for all.");
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
