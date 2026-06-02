import { readFileSync } from "fs"; import { resolve } from "path";
import { Client } from "pg";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const password = process.env.SUPABASE_DB_PASSWORD!;
const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
const cs = `postgres://postgres.urjbhjbygyxffrfkarqn:${encodeURIComponent(password)}@${host}:6543/postgres`;

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  const j = await c.query(`SELECT slug, name, journey_type, trigger_intent, channels, match_patterns, step_ticket_status, priority FROM journey_definitions WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906' AND is_active=true ORDER BY priority`);
  console.log(JSON.stringify(j.rows, null, 2));
  console.log("---playbooks---");
  const p = await c.query(`SELECT slug, name, trigger_intents, description FROM playbooks WHERE workspace_id = 'fdc11e10-b89f-4989-8b73-ed6526c4d906' AND is_active=true ORDER BY priority`);
  console.log(JSON.stringify(p.rows, null, 2));
  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
