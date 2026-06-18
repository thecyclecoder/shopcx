/**
 * Applies the portal ai_channel_config constraint migration, then seeds
 * the active workspace's portal channel from its live-chat settings:
 *   - inserts an ai_channel_config row for channel 'portal' cloned from 'chat'
 *   - adds a 'portal' key to workspaces.response_delays (= the chat delay)
 *
 * Idempotent: re-running upserts the same portal config and re-syncs the
 * delay. Safe to run after deploy.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const envPath = resolve(__dirname, "../.env.local");
if (existsSync(envPath)) for (const line of readFileSync(envPath, "utf8").split("\n")) { const t = line.trim(); if (!t || t.startsWith("#")) continue; const eq = t.indexOf("="); if (eq < 0) continue; const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1); }

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const { Client } = await import("pg");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const host = url.replace("https://", "").replace(".supabase.co", "");
  const password = process.env.SUPABASE_DB_PASSWORD!;
  const candidates = [
    `postgresql://postgres.${host}:${encodeURIComponent(password)}@aws-1-us-east-2.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${host}:${encodeURIComponent(password)}@aws-1-us-west-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${host}:${encodeURIComponent(password)}@aws-1-us-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres:${encodeURIComponent(password)}@db.${host}.supabase.co:5432/postgres`,
  ];
  let conn = "";
  for (const c of candidates) {
    const probe = new Client({ connectionString: c, connectionTimeoutMillis: 4000 });
    try { await probe.connect(); await probe.end(); conn = c; console.log("connected via", c.split("@")[1]); break; } catch { /* try next */ }
  }
  if (!conn) throw new Error("no connection string worked");
  const client = new Client({ connectionString: conn });
  await client.connect();

  const sql = readFileSync(resolve(__dirname, "../supabase/migrations/20260618130000_ai_channel_config_portal.sql"), "utf8");
  await client.query(sql);
  console.log("✓ constraint updated — 'portal' now allowed in ai_channel_config");

  // Clone the chat config row into a portal row (exact live-chat settings).
  await client.query(
    `INSERT INTO public.ai_channel_config
       (workspace_id, channel, personality_id, enabled, sandbox, instructions, max_response_length, confidence_threshold, auto_resolve, ai_turn_limit)
     SELECT workspace_id, 'portal', personality_id, enabled, sandbox, instructions, max_response_length, confidence_threshold, auto_resolve, ai_turn_limit
       FROM public.ai_channel_config
      WHERE workspace_id = $1 AND channel = 'chat'
     ON CONFLICT (workspace_id, channel) DO UPDATE SET
       personality_id = EXCLUDED.personality_id,
       enabled = EXCLUDED.enabled,
       sandbox = EXCLUDED.sandbox,
       instructions = EXCLUDED.instructions,
       max_response_length = EXCLUDED.max_response_length,
       confidence_threshold = EXCLUDED.confidence_threshold,
       auto_resolve = EXCLUDED.auto_resolve,
       ai_turn_limit = EXCLUDED.ai_turn_limit,
       updated_at = now()`,
    [WORKSPACE_ID],
  );
  const cfg = await client.query(`SELECT channel, enabled, sandbox, personality_id, confidence_threshold, auto_resolve, max_response_length, ai_turn_limit FROM public.ai_channel_config WHERE workspace_id=$1 AND channel IN ('chat','portal') ORDER BY channel`, [WORKSPACE_ID]);
  console.log("✓ portal config seeded from chat:");
  cfg.rows.forEach((r) => console.log("   ", JSON.stringify(r)));

  // Add 'portal' to response_delays, matching the chat delay.
  await client.query(
    `UPDATE public.workspaces
        SET response_delays = jsonb_set(
              coalesce(response_delays, '{}'::jsonb),
              '{portal}',
              coalesce(response_delays->'chat', '15'::jsonb),
              true)
      WHERE id = $1`,
    [WORKSPACE_ID],
  );
  const wd = await client.query(`SELECT response_delays FROM public.workspaces WHERE id=$1`, [WORKSPACE_ID]);
  console.log("✓ response_delays:", JSON.stringify(wd.rows[0].response_delays));

  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
