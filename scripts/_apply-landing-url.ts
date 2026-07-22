/** Apply the ad_campaigns.landing_url migration (killer-statics).
 * Tries the direct host, then the common Supabase poolers, applies on first connect.
 * Run: npx tsx scripts/_apply-landing-url.ts
 */
import { readFileSync } from "fs";
import { errText } from "../src/lib/error-text";
import { Client } from "pg";
for (const line of readFileSync("/Users/admin/Projects/shopcx/.env.local", "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  if (!process.env[t.slice(0, eq)]) process.env[t.slice(0, eq)] = t.slice(eq + 1);
}
const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").match(/https:\/\/([a-z0-9]+)\.supabase\.co/)?.[1];
const pwd = process.env.SUPABASE_DB_PASSWORD;
if (!ref || !pwd) { console.error("missing ref or SUPABASE_DB_PASSWORD"); process.exit(1); }

// Candidate connections: direct host first, then common pooler regions/prefixes.
const candidates: Array<{ label: string; host: string; user: string }> = [
  { label: "direct", host: `db.${ref}.supabase.co`, user: "postgres" },
  ...["us-east-1", "us-east-2", "us-west-1", "us-west-2"].flatMap((region) =>
    ["aws-0", "aws-1"].map((prefix) => ({ label: `${prefix}-${region}`, host: `${prefix}-${region}.pooler.supabase.com`, user: `postgres.${ref}` })),
  ),
];

const DDL = [
  `ALTER TABLE public.ad_campaigns ADD COLUMN IF NOT EXISTS landing_url text`,
  `COMMENT ON COLUMN public.ad_campaigns.landing_url IS 'Default click-through destination for this ad (pre-fills the Meta publish panel). Set from the archetype->lander map at seed time; operator-overridable.'`,
];

async function tryOne(c: { label: string; host: string; user: string }): Promise<boolean> {
  const client = new Client({ host: c.host, port: 5432, user: c.user, password: pwd, database: "postgres", ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
  } catch (e) {
    console.log(`· ${c.label}: ${(errText(e)).slice(0, 80)}`);
    try { await client.end(); } catch {}
    return false;
  }
  console.log(`connected via ${c.label} (${c.host})`);
  for (const sql of DDL) await client.query(sql);
  const { rows } = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='ad_campaigns' AND column_name='landing_url'`,
  );
  console.log("landing_url column:", rows);
  await client.end();
  return true;
}

async function main() {
  for (const c of candidates) {
    if (await tryOne(c)) { console.log("\n✓ migration applied"); return; }
  }
  console.error("\n✗ could not connect via any candidate host");
  process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
