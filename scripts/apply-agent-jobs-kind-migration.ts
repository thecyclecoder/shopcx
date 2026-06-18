import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

// Load .env.local IF present (local dev). On the BUILD BOX there is NONE — secrets come from the
// process env (systemd EnvironmentFile). Guard with existsSync or the apply crashes with ENOENT.
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

const password = process.env.SUPABASE_DB_PASSWORD;
const cs =
  process.env.SUPABASE_DB_URL ||
  process.env.DATABASE_URL ||
  `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password || "")}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;
const MIGRATIONS = ["20260618140000_agent_jobs_kind.sql"];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select count(*)::int as n from information_schema.columns where table_name='agent_jobs' and column_name='kind'",
    );
    console.log(`✓ kind present: ${rows[0].n === 1}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
