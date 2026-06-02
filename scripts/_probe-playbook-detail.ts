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
  const pbs = await c.query(`SELECT id, name FROM playbooks WHERE is_active=true ORDER BY priority DESC`);
  for (const pb of pbs.rows) {
    console.log(`\n=== ${pb.name} (${pb.id}) ===`);
    const steps = await c.query(`SELECT step_number, name, step_type, config FROM playbook_steps WHERE playbook_id=$1 ORDER BY step_number`, [pb.id]);
    console.log(`Steps (${steps.rows.length}):`);
    for (const s of steps.rows) console.log(`  ${s.step_number}. [${s.step_type}] ${s.name}`);
    const polCols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='playbook_policies' ORDER BY ordinal_position`);
    console.log("\nPolicy columns:", polCols.rows.map(r=>r.column_name).join(", "));
    const pols = await c.query(`SELECT * FROM playbook_policies WHERE playbook_id=$1 ORDER BY sort_order`, [pb.id]);
    console.log(`Policies (${pols.rows.length}):`);
    for (const p of pols.rows) console.log(`  - ${p.name}: ${p.description?.slice(0,200) || ""}`);
    const excCols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='playbook_exceptions' ORDER BY ordinal_position`);
    console.log("\nException columns:", excCols.rows.map(r=>r.column_name).join(", "));
    const excs = await c.query(`SELECT * FROM playbook_exceptions WHERE playbook_id=$1 LIMIT 10`, [pb.id]);
    console.log(`Exceptions (${excs.rows.length}):`);
    for (const e of excs.rows) console.log(`  - ${e.name}: ${e.description?.slice(0,200) || ""}`);
  }
  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
