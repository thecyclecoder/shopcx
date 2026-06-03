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
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PID = "ea433e56-0aa4-4b46-9107-feb11f77f533";

async function main() {
  const c = new Client({ connectionString: cs }); await c.connect();

  const cols = async (t: string) => (await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [t])).rows.map((x:any)=>x.column_name);

  for (const t of ["product_benefit_angles", "product_benefit_selections", "product_page_content", "product_how_it_works"]) {
    console.log(`\n══ ${t} ══`);
    console.log("cols:", (await cols(t)).join(", "));
  }

  console.log("\n── product_benefit_angles (Amazing Coffee) ──");
  const angles = (await c.query(`SELECT * FROM product_benefit_angles WHERE product_id=$1 ORDER BY display_order NULLS LAST, created_at LIMIT 20`, [PID])).rows;
  for (const a of angles) console.log(JSON.stringify(a, null, 2).slice(0, 800));

  console.log("\n── product_benefit_selections (Amazing Coffee) ──");
  const sel = (await c.query(`SELECT * FROM product_benefit_selections WHERE product_id=$1 LIMIT 20`, [PID])).rows;
  for (const s of sel) console.log(JSON.stringify(s, null, 2).slice(0, 600));

  console.log("\n── product_page_content (Amazing Coffee) ──");
  const ppc = (await c.query(`SELECT * FROM product_page_content WHERE product_id=$1 LIMIT 5`, [PID])).rows;
  for (const p of ppc) console.log(JSON.stringify(p, null, 2).slice(0, 1200));

  console.log("\n── product_how_it_works (Amazing Coffee) ──");
  const hiw = (await c.query(`SELECT * FROM product_how_it_works WHERE product_id=$1 LIMIT 5`, [PID])).rows;
  for (const h of hiw) console.log(JSON.stringify(h, null, 2).slice(0, 800));

  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
