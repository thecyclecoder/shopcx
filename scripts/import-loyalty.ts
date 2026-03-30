#!/usr/bin/env npx tsx
/**
 * Import loyalty points from Smile.io JSON export.
 * Run: npx tsx scripts/import-loyalty.ts
 *
 * Batch approach: process loyalty records in chunks of 200,
 * look up only those emails in the DB per batch (avoids loading 619K customers).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local
const envPath = resolve(__dirname, "../.env.local");
const lines = readFileSync(envPath, "utf8").split("\n");
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) continue;
  const eq = trimmed.indexOf("=");
  if (eq < 0) continue;
  const key = trimmed.slice(0, eq);
  const val = trimmed.slice(eq + 1);
  if (!process.env[key]) process.env[key] = val;
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const INPUT_FILE = resolve(__dirname, "../tmp/customers_2026-03-30T17_54_27.736397284Z.json");
const BATCH_SIZE = 200;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

interface SmileRecord {
  "Smile Customer ID": string;
  "First name": string;
  "Last name": string;
  "Email": string;
  "Membership status": string;
  "Points balance": string;
  "Referral url": string;
  "Vip tier name": string;
  "Date of birth": string;
}

function parsePoints(raw: string): number {
  return parseInt(raw.replace(/,/g, ""), 10) || 0;
}

const POINTS_PER_DOLLAR = 10; // must match loyalty_settings

async function lookupCustomersByEmail(
  emails: string[],
): Promise<Map<string, { id: string; shopify_customer_id: string; ltv: number }>> {
  const map = new Map<string, { id: string; shopify_customer_id: string; ltv: number }>();
  if (!emails.length) return map;

  const { data, error } = await supabase
    .from("customers")
    .select("id, email, shopify_customer_id, ltv_cents")
    .eq("workspace_id", WORKSPACE_ID)
    .in("email", emails);

  if (error) {
    console.error("Customer lookup error:", error.message);
    return map;
  }

  for (const c of data || []) {
    if (c.email) map.set(c.email.toLowerCase(), { id: c.id, shopify_customer_id: c.shopify_customer_id, ltv: (Number(c.ltv_cents) || 0) / 100 });
  }
  return map;
}

async function main() {
  console.log("Reading Smile.io export...");
  const raw = readFileSync(INPUT_FILE, "utf8");
  const allRecords: SmileRecord[] = JSON.parse(raw);

  // Filter to records with points > 0
  const records = allRecords.filter((r) => parsePoints(r["Points balance"]) > 0);
  console.log(`Found ${allRecords.length} total records, ${records.length} with points > 0`);

  let imported = 0;
  let skippedNoMatch = 0;
  let errors = 0;
  let totalPoints = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(records.length / BATCH_SIZE);
    console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} records)...`);

    // Collect emails for this batch
    const emails = batch
      .map((r) => (r["Email"] || "").toLowerCase().trim())
      .filter(Boolean);

    // Look up only these emails
    const customerMap = await lookupCustomersByEmail(emails);

    for (const record of batch) {
      const email = (record["Email"] || "").toLowerCase().trim();
      const points = parsePoints(record["Points balance"]);

      const customer = customerMap.get(email);
      if (!customer) {
        skippedNoMatch++;
        continue;
      }

      // Estimate points_earned from LTV, points_spent as the difference
      const estimatedEarned = Math.max(points, Math.floor(customer.ltv * POINTS_PER_DOLLAR));
      const estimatedSpent = Math.max(0, estimatedEarned - points);

      // Upsert loyalty_members
      const { data: member, error: memberErr } = await supabase
        .from("loyalty_members")
        .upsert(
          {
            workspace_id: WORKSPACE_ID,
            customer_id: customer.id,
            shopify_customer_id: customer.shopify_customer_id,
            email,
            points_balance: points,
            points_earned: estimatedEarned,
            points_spent: estimatedSpent,
            source: "import",
          },
          { onConflict: "workspace_id,shopify_customer_id" },
        )
        .select("id")
        .single();

      if (memberErr) {
        console.error(`  ERROR upserting ${email}:`, memberErr.message);
        errors++;
        continue;
      }

      // Insert import transaction
      const { error: txErr } = await supabase
        .from("loyalty_transactions")
        .insert({
          workspace_id: WORKSPACE_ID,
          member_id: member.id,
          points_change: points,
          type: "import",
          description: "Imported from Smile.io",
        });

      if (txErr) {
        console.error(`  ERROR transaction ${email}:`, txErr.message);
        errors++;
        continue;
      }

      imported++;
      totalPoints += points;
    }

    console.log(`  Batch done — imported so far: ${imported}, skipped: ${skippedNoMatch}`);
  }

  console.log("\n=== Import Summary ===");
  console.log(`Imported: ${imported}`);
  console.log(`Skipped (no match): ${skippedNoMatch}`);
  console.log(`Errors: ${errors}`);
  console.log(`Total points imported: ${totalPoints.toLocaleString()}`);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
