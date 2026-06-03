import { readFileSync } from "fs"; import { resolve } from "path"; import { Client } from "pg";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const password = process.env.SUPABASE_DB_PASSWORD!;
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;
async function main() {
  const c = new Client({ connectionString: cs }); await c.connect();
  const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='sonnet_prompts' AND (column_name LIKE 'auto_%' OR column_name IN ('superseded_by_id','merged_into_id','source_pattern_id')) ORDER BY column_name`);
  console.log("sonnet_prompts new cols:", r.rows.map((x:any)=>x.column_name).join(", "));
  const r2 = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='sonnet_prompt_decisions' ORDER BY ordinal_position`);
  console.log(`sonnet_prompt_decisions: ${r2.rows.length} cols`);
  for (const row of r2.rows) console.log("  - " + row.column_name);
  const r3 = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name='workspaces' AND column_name LIKE 'sonnet_%' ORDER BY column_name`);
  console.log("workspaces sonnet_*:", r3.rows.map((x:any)=>x.column_name).join(", "));
  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
