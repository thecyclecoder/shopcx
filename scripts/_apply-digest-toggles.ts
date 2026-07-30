import { loadEnv } from "./_bootstrap"; loadEnv();
import { readFileSync } from "fs";
import { Client } from "pg";

// Apply the two digest-toggle migrations (add columns) + set both flags FALSE for Superfoods, silencing
// the media-buyer (Bianca) 2h digest AND the ads-supervisor drift digest Max posts to #director-growth-max.
// Idempotent (add column if not exists). Uses the SESSION pooler (5432) for multi-statement DDL.
const PROJECT_REF = "urjbhjbygyxffrfkarqn";
const DEFAULT_HOST = "aws-1-us-east-1.pooler.supabase.com";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods

function connString(): string {
  let s = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || "";
  if (!s) {
    const pw = process.env.SUPABASE_DB_PASSWORD;
    if (!pw) throw new Error("no SUPABASE_DB_URL / DATABASE_URL / SUPABASE_DB_PASSWORD in env");
    s = `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(pw)}@${process.env.SUPABASE_DB_HOST || DEFAULT_HOST}:5432/postgres`;
  }
  return s.replace(":6543/", ":5432/");
}

(async () => {
  const client = new Client({ connectionString: connString(), statement_timeout: 30000, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    for (const f of [
      "supabase/migrations/20261022130000_workspaces_media_buyer_digest_enabled.sql",
      "supabase/migrations/20261022140000_workspaces_ads_supervisor_digest_enabled.sql",
    ]) {
      console.log(`applying ${f} …`);
      await client.query(readFileSync(f, "utf8"));
    }
    console.log("setting both flags FALSE for Superfoods …");
    await client.query(
      `update public.workspaces set media_buyer_digest_enabled = false, ads_supervisor_digest_enabled = false where id = $1`,
      [WS],
    );
    const { rows } = await client.query<{ mb: boolean; as: boolean }>(
      `select media_buyer_digest_enabled as mb, ads_supervisor_digest_enabled as "as" from public.workspaces where id = $1`,
      [WS],
    );
    console.log("Superfoods now → media_buyer_digest_enabled:", rows[0]?.mb, "| ads_supervisor_digest_enabled:", rows[0]?.as);
  } finally {
    await client.end();
  }
})().then(() => process.exit(0)).catch((e) => { console.error("APPLY FAILED:", e instanceof Error ? e.message : e); process.exit(1); });
