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

const MIGRATIONS = ["20260706130000_feed_beat_atomic_throttle.sql"];

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      const sql = readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8");
      await c.query(sql);
      console.log(`✓ applied ${file}`);
    }
    // Smoke-test the atomic throttle: two back-to-back beats for the same source in the same minute
    // must collapse to ONE row (the second ON CONFLICT DO NOTHINGs). Uses a throwaway loop_id and
    // cleans up after itself so it leaves no residue in the live feed panels.
    const probeId = "feed:__throttle_probe__";
    await c.query("delete from public.loop_heartbeats where loop_id = $1", [probeId]);
    await c.query("select public.record_feed_beat($1)", [probeId]);
    await c.query("select public.record_feed_beat($1)", [probeId]);
    const { rows } = await c.query(
      "select count(*)::int as n from public.loop_heartbeats where loop_id = $1",
      [probeId],
    );
    await c.query("delete from public.loop_heartbeats where loop_id = $1", [probeId]);
    if (rows[0].n !== 1) throw new Error(`expected 1 beat after 2 same-minute calls, got ${rows[0].n}`);
    console.log("✓ record_feed_beat: 2 same-minute calls → 1 row (atomic ON CONFLICT DO NOTHING)");
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
