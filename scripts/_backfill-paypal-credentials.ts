/**
 * Ship-time backfill: copy the PayPal REST credentials from the Shoptics DB into ShopCX's
 * `workspaces` row, encrypting the secret with ShopCX's own key.
 *
 * PayPal is the last processor the close cannot roll up on ShopCX. Its fees/refunds/chargebacks
 * come from PayPal's own reporting API — they never appear in Shopify's payout summaries, because
 * PayPal settles into PayPal — and July's block is real money ($31,166.36 gross / $1,001.92 fees).
 *
 * Applies the migration first (idempotent `add column if not exists`), then writes. Idempotent:
 * re-running simply re-encrypts the same values. Prints NO secret material.
 *
 * Usage: npx tsx scripts/_backfill-paypal-credentials.ts
 */
import { loadEnv, pgClient } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { encrypt } from "../src/lib/crypto";
import { readFileSync } from "fs";
import { resolve } from "path";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  // 1. schema
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations/20261213140000_workspace_paypal_credentials.sql"), "utf8"));
    console.log("✓ paypal credential columns present");
  } finally {
    await c.end();
  }

  // 2. read from Shoptics (read-only)
  const env: Record<string, string> = {};
  for (const l of readFileSync("/Users/admin/Projects/shoptics/.env.local", "utf8").split("\n")) {
    const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/integration_credentials?select=credentials&id=eq.paypal`, {
    headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    cache: "no-store",
  });
  const rows = (await res.json()) as { credentials: Record<string, string> }[];
  const creds = rows?.[0]?.credentials;
  if (!creds?.client_id || !creds?.client_secret) throw new Error("no PayPal credentials found in the Shoptics DB");
  console.log(`✓ read PayPal credentials from Shoptics (environment=${creds.environment ?? "production"})`);

  // 3. write to ShopCX, secret encrypted with ShopCX's key
  const admin = createAdminClient();
  const { error } = await admin
    .from("workspaces")
    .update({
      paypal_client_id: creds.client_id,
      paypal_client_secret_encrypted: encrypt(creds.client_secret),
      paypal_environment: creds.environment ?? "production",
    })
    .eq("id", WS);
  if (error) throw new Error(error.message);

  const { data: check } = await admin
    .from("workspaces")
    .select("paypal_client_id, paypal_client_secret_encrypted, paypal_environment")
    .eq("id", WS)
    .single();
  console.log(
    `✓ stored on workspace — client_id ${check?.paypal_client_id ? "set" : "MISSING"}, ` +
      `secret ${check?.paypal_client_secret_encrypted ? "encrypted" : "MISSING"}, env ${check?.paypal_environment}`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
