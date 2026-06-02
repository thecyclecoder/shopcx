import { readFileSync } from "fs"; import { resolve } from "path";
import { Client } from "pg";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const password = process.env.SUPABASE_DB_PASSWORD!;
const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@${host}:6543/postgres`;
async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='playbooks' ORDER BY ordinal_position`);
  console.log("playbooks columns:");
  for (const r of cols.rows) console.log("  " + r.column_name);
  console.log("---rows---");
  const all = await c.query(`SELECT * FROM playbooks WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906' ORDER BY id LIMIT 30`);
  console.log(`count: ${all.rows.length}`);
  for (const r of all.rows) console.log(JSON.stringify(r, null, 2));
  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
