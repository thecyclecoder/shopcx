#!/usr/bin/env npx tsx
/**
 * Import loyalty points from Smile.io JSON export.
 * Run: npx tsx scripts/import-loyalty.ts
 *
 * Reads: tmp/customers_2026-03-30T17_54_27.736397284Z.json
 * Format per record: { "Smile Customer ID", "First name", "Last name", "Email",
 *   "Membership status", "Points balance", "Referral url", "Vip tier name", "Date of birth" }
 *
 * Points balance is comma-formatted string (e.g., "89,085") — parsed to integer.
 * Match by email to customers table. Skip unmatched + 0-balance.
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load env
const envPath = resolve(import.meta.dirname, "../.env.local");
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
const INPUT_FILE = resolve(import.meta.dirname, "../tmp/customers_2026-03-30T17_54_27.736397284Z.json");

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
  // "89,085" → 89085
  return parseInt(raw.replace(/,/g, ""), 10) || 0;
}

async function main() {
  console.log("Reading Smile.io export...");
  const raw = readFileSync(INPUT_FILE, "utf8");
  const records: SmileRecord[] = JSON.parse(raw);
  console.log(`Found ${records.length} records in export`);

  // Load all workspace customers by email for fast lookup
  console.log("Loading customers from DB...");
  const { data: customers, error: custErr } = await supabase
    .from("customers")
    .select("id, email, shopify_customer_id")
    .eq("workspace_id", WORKSPACE_ID)
    .not("email", "is", null);

  if (custErr) {
    console.error("Failed to load customers:", custErr.message);
    process.exit(1);
  }

  const customerByEmail = new Map<string, { id: string; shopify_customer_id: string }>();
  for (const c of customers || []) {
    if (c.email) customerByEmail.set(c.email.toLowerCase(), c);
  }
  console.log(`Loaded ${customerByEmail.size} customers`);

  let imported = 0;
  let skippedNoMatch = 0;
  let skippedZero = 0;
  let totalPoints = 0;

  for (const record of records) {
    const email = (record["Email"] || "").toLowerCase().trim();
    const points = parsePoints(record["Points balance"]);

    if (points <= 0) {
      skippedZero++;
      continue;
    }

    const customer = customerByEmail.get(email);
    if (!customer) {
      skippedNoMatch++;
      if (points >= 100) {
        // Only warn for non-trivial balances
        console.warn(`  SKIP (no match): ${email} — ${points} pts`);
      }
      continue;
    }

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
          points_earned: points, // Historical total unknown; use balance as starting earned
          points_spent: 0,
          source: "import",
        },
        { onConflict: "workspace_id,shopify_customer_id" },
      )
      .select("id")
      .single();

    if (memberErr) {
      console.error(`  ERROR upserting member ${email}:`, memberErr.message);
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
      console.error(`  ERROR inserting transaction for ${email}:`, txErr.message);
      continue;
    }

    imported++;
    totalPoints += points;
  }

  console.log("\n=== Import Summary ===");
  console.log(`Imported: ${imported}`);
  console.log(`Skipped (no match): ${skippedNoMatch}`);
  console.log(`Skipped (0 balance): ${skippedZero}`);
  console.log(`Total points imported: ${totalPoints.toLocaleString()}`);
}

main().catch((err) => {
  console.error("Import failed:", err);
  process.exit(1);
});
