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

  console.log("=== ticket_messages.visibility ===");
  const r = await c.query(`SELECT visibility, COUNT(*) FROM ticket_messages GROUP BY visibility ORDER BY count DESC`);
  for (const row of r.rows) console.log(`  ${row.visibility}: ${row.count}`);

  console.log("\n=== ticket_messages.direction ===");
  const r2 = await c.query(`SELECT direction, COUNT(*) FROM ticket_messages GROUP BY direction ORDER BY count DESC`);
  for (const row of r2.rows) console.log(`  ${row.direction}: ${row.count}`);

  console.log("\n=== transactions.type ===");
  const r3 = await c.query(`SELECT type, COUNT(*) FROM transactions GROUP BY type ORDER BY count DESC`);
  for (const row of r3.rows) console.log(`  ${row.type}: ${row.count}`);

  console.log("\n=== transactions.status ===");
  const r4 = await c.query(`SELECT status, COUNT(*) FROM transactions GROUP BY status ORDER BY count DESC`);
  for (const row of r4.rows) console.log(`  ${row.status}: ${row.count}`);

  console.log("\n=== ticket_messages.author_id check (uuids vs strings?) ===");
  const r5 = await c.query(`SELECT author_id, author_type, COUNT(*) FROM ticket_messages GROUP BY author_id, author_type LIMIT 10`);
  for (const row of r5.rows) console.log(`  type=${row.author_type} id=${row.author_id}: ${row.count}`);

  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
