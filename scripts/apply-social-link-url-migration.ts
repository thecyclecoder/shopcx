import { readFileSync } from "fs"; import { resolve } from "path"; import { Client } from "pg";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const password = process.env.SUPABASE_DB_PASSWORD!;
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;
const sql = readFileSync(resolve(__dirname, "../supabase/migrations/20260616140000_social_post_link_url.sql"), "utf8");
async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    await c.query(sql);
    const r = await c.query(`SELECT 1 FROM information_schema.columns WHERE table_name='scheduled_social_posts' AND column_name='link_url'`);
    console.log(r.rows.length === 1 ? "✓ applied — link_url present" : "✗ column missing after apply");
  } finally { await c.end(); }
}
main().catch(e => { console.error(e); process.exit(1); });
