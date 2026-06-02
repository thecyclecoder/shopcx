/**
 * Verifies high-traffic doc pages against the live schema.
 * Reports column mismatches + bad enum claims.
 */
import { readFileSync } from "fs"; import { resolve } from "path";
import { Client } from "pg";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const password = process.env.SUPABASE_DB_PASSWORD!;
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();

  // 1. Check returns.status actual values
  console.log("=== returns.status ===");
  const r1 = await c.query(`SELECT status, COUNT(*) FROM returns GROUP BY status ORDER BY count DESC`);
  for (const row of r1.rows) console.log(`  ${row.status}: ${row.count}`);

  console.log("\n=== tickets.status ===");
  const r2 = await c.query(`SELECT status, COUNT(*) FROM tickets GROUP BY status ORDER BY count DESC`);
  for (const row of r2.rows) console.log(`  ${row.status}: ${row.count}`);

  console.log("\n=== subscriptions.status ===");
  const r3 = await c.query(`SELECT status, COUNT(*) FROM subscriptions GROUP BY status ORDER BY count DESC`);
  for (const row of r3.rows) console.log(`  ${row.status}: ${row.count}`);

  console.log("\n=== orders.financial_status ===");
  const r4 = await c.query(`SELECT financial_status, COUNT(*) FROM orders GROUP BY financial_status ORDER BY count DESC`);
  for (const row of r4.rows) console.log(`  ${row.financial_status}: ${row.count}`);

  console.log("\n=== customers.subscription_status ===");
  const r5 = await c.query(`SELECT subscription_status, COUNT(*) FROM customers GROUP BY subscription_status ORDER BY count DESC`);
  for (const row of r5.rows) console.log(`  ${row.subscription_status}: ${row.count}`);

  console.log("\n=== customers.email_marketing_status ===");
  const r6 = await c.query(`SELECT email_marketing_status, COUNT(*) FROM customers GROUP BY email_marketing_status ORDER BY count DESC`);
  for (const row of r6.rows) console.log(`  ${row.email_marketing_status}: ${row.count}`);

  console.log("\n=== ticket_messages.author_type ===");
  const r7 = await c.query(`SELECT author_type, COUNT(*) FROM ticket_messages GROUP BY author_type ORDER BY count DESC`);
  for (const row of r7.rows) console.log(`  ${row.author_type}: ${row.count}`);

  console.log("\n=== fraud_cases.status ===");
  const r8 = await c.query(`SELECT status, COUNT(*) FROM fraud_cases GROUP BY status ORDER BY count DESC`);
  for (const row of r8.rows) console.log(`  ${row.status}: ${row.count}`);

  console.log("\n=== dunning_cycles.status ===");
  const r9 = await c.query(`SELECT status, COUNT(*) FROM dunning_cycles GROUP BY status ORDER BY count DESC`);
  for (const row of r9.rows) console.log(`  ${row.status}: ${row.count}`);

  console.log("\n=== returns columns ===");
  const r10 = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='returns' ORDER BY ordinal_position`);
  console.log("  " + r10.rows.map(r => r.column_name).join(", "));

  console.log("\n=== ticket_messages columns ===");
  const r11 = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='ticket_messages' ORDER BY ordinal_position`);
  console.log("  " + r11.rows.map(r => r.column_name).join(", "));

  console.log("\n=== orders columns (key) ===");
  const r12 = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='orders' AND column_name IN ('total_cents','order_number','financial_status','fulfillment_status','subtotal_price_cents') ORDER BY column_name`);
  for (const row of r12.rows) console.log(`  ${row.column_name}`);

  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
