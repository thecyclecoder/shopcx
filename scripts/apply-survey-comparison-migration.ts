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
const MIGRATIONS = ["20260620120000_product_page_content_survey_comparison.sql"];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select column_name from information_schema.columns where table_name='product_page_content' and column_name in ('show_survey','comparison_competitor_label') order by column_name",
    );
    console.log(`✓ columns present: ${rows.map((r) => r.column_name).join(", ")}`);
    const { rows: surveyed } = await c.query(
      "select count(*)::int as n from public.product_page_content where show_survey = true",
    );
    console.log(`✓ show_survey=true rows (coffee): ${surveyed[0].n}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
