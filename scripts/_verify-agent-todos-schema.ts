import { readFileSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";
for (const line of readFileSync(resolve(process.cwd(), ".env.local"),"utf8").split("\n")) {
  const t=line.trim(); if(!t||t.startsWith("#")) continue;
  const eq=t.indexOf("="); if(eq<0) continue;
  if(!process.env[t.slice(0,eq)]) process.env[t.slice(0,eq)]=t.slice(eq+1);
}
async function main() {
  const pw = process.env.SUPABASE_DB_PASSWORD!;
  const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(pw)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;
  const c = new Client({ connectionString: cs });
  await c.connect();

  const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='agent_todos' ORDER BY ordinal_position`);
  console.log(`columns: ${cols.rows.length}`);
  for (const r of cols.rows) console.log(`  ${r.column_name}`);

  const idx = await c.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='agent_todos'`);
  console.log(`\nindexes: ${idx.rows.length}`);
  for (const r of idx.rows) console.log(`  ${r.indexname}`);

  const pol = await c.query(`SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='agent_todos'`);
  console.log(`\npolicies: ${pol.rows.length}`);
  for (const r of pol.rows) console.log(`  ${r.policyname}`);

  await c.end();
}
main().catch(e=>{console.error(e);process.exit(1);});
