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
// ALTER TYPE ... ADD VALUE cannot run inside a transaction block, so run it on its own (no wrapping tx).
const MIGRATIONS = ["20260620150100_workspace_role_cs_manager.sql"];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'workspace_role' order by e.enumsortorder",
    );
    console.log(`✓ workspace_role values: ${rows.map((r) => r.enumlabel).join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
