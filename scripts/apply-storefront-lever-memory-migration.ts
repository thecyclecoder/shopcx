import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

// .env.local is present locally but ABSENT on the build box (secrets come from the systemd
// EnvironmentFile via process.env) — guard the read or this crashes ENOENT before connecting.
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq);
    if (!process.env[k]) process.env[k] = t.slice(eq + 1);
  }
}

const password = process.env.SUPABASE_DB_PASSWORD!;
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;
const MIGRATIONS = ["20260624120000_storefront_lever_memory.sql"];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const cols = await c.query(
      "select table_name, count(*)::int as n from information_schema.columns where table_schema='public' and table_name in ('storefront_levers','storefront_lever_importance') group by table_name order by table_name",
    );
    for (const r of cols.rows) console.log(`✓ public.${r.table_name} has ${r.n} columns`);
    const seeded = await c.query("select count(*)::int as n from public.storefront_levers");
    console.log(`✓ storefront_levers seeded: ${seeded.rows[0]?.n} levers`);
    const chapters = await c.query(
      "select lever_key, prior from public.storefront_levers where level='chapter' order by prior desc",
    );
    console.log(`✓ chapter priors (desc): ${chapters.rows.map((r) => `${r.lever_key}=${r.prior}`).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
