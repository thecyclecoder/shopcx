import { loadEnv, pgClient } from "./_bootstrap";
import { readFileSync } from "fs";

const KEY_PATH = "/Users/admin/Downloads/shopgrowth-902fe66b44e8.json";

(async () => {
  loadEnv();
  const { encrypt, decrypt } = await import("../src/lib/crypto");

  const raw = readFileSync(KEY_PATH, "utf8");
  const parsed = JSON.parse(raw) as { client_email: string; project_id: string; type: string };
  if (parsed.type !== "service_account") throw new Error("not a service_account key");

  const c = pgClient();
  await c.connect();
  // DDL (idempotent — mirrors the migration)
  await c.query(`alter table public.workspaces add column if not exists google_drive_sa_json_encrypted text`);

  // Resolve the active workspace (the one already holding the Gemini key; fall back to name)
  const { rows } = await c.query(
    `select id, name from public.workspaces
     where gemini_api_key_encrypted is not null or name ilike '%superfood%'
     order by (gemini_api_key_encrypted is not null) desc, created_at asc limit 1`,
  );
  if (!rows.length) throw new Error("no workspace found");
  const ws = rows[0];

  const enc = encrypt(raw);
  await c.query(`update public.workspaces set google_drive_sa_json_encrypted = $1 where id = $2`, [enc, ws.id]);

  // Verify round-trip without printing the key
  const { rows: r2 } = await c.query(`select google_drive_sa_json_encrypted from public.workspaces where id = $1`, [ws.id]);
  const back = JSON.parse(decrypt(r2[0].google_drive_sa_json_encrypted)) as { client_email: string };
  console.log(`✓ stored on workspace "${ws.name}" (${ws.id})`);
  console.log(`✓ round-trip OK — client_email: ${back.client_email}, project: ${parsed.project_id}`);
  console.log(`✓ matches: ${back.client_email === parsed.client_email}`);
  await c.end();
})().catch((e) => { console.error("err:", e.message); process.exit(1); });
