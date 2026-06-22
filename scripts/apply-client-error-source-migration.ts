import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { Client } from "pg";

// Load .env.local IF present (local dev). On the build box there is none — secrets come from the
// process env (systemd EnvironmentFile). Guard the read or the apply crashes with ENOENT.
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
const cs =
  process.env.SUPABASE_DB_URL ||
  process.env.DATABASE_URL ||
  `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;

const MIGRATIONS = ["20260622170000_client_error_source.sql"];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      const sql = readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8");
      await c.query(sql);
      console.log(`✓ applied ${file}`);
    }
    const { rows: chk } = await c.query(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'error_events_source_check'",
    );
    console.log(`✓ error_events source check: ${chk[0]?.def ?? "MISSING"}`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
