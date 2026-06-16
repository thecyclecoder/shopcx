import { readFileSync } from "fs"; import { resolve } from "path"; import { Client } from "pg";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(process.env.SUPABASE_DB_PASSWORD!)}@aws-1-us-east-1.pooler.supabase.com:6543/postgres`;
const sql = readFileSync(resolve(__dirname, "../supabase/migrations/20260616141000_social_post_blog_source_kind.sql"), "utf8");
(async () => {
  const c = new Client({ connectionString: cs }); await c.connect();
  await c.query(sql);
  const r = await c.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname='scheduled_social_posts_source_kind_check'`);
  console.log("✓ constraint now:", r.rows[0]?.def);
  await c.end();
})().catch(e=>{console.error(e);process.exit(1);});
