/**
 * Dumps public.* schema (columns, FKs, PKs, indexes) to tmp-schema.json.
 * Used by `_gen-brain-docs.ts` to regenerate `docs/brain/tables/`.
 *   npx tsx scripts/_dump-schema.ts
 */
import { readFileSync, writeFileSync } from "fs"; import { resolve } from "path";
import { Client } from "pg";
const envPath = resolve(__dirname, "../.env.local");
for (const line of readFileSync(envPath, "utf8").split("\n")) {
  const t = line.trim(); if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("="); if (eq < 0) continue;
  const k = t.slice(0, eq); if (!process.env[k]) process.env[k] = t.slice(eq + 1);
}
const password = process.env.SUPABASE_DB_PASSWORD!;
const host = process.env.SUPABASE_DB_HOST || "aws-1-us-east-1.pooler.supabase.com";
const PROJECT_REF = "urjbhjbygyxffrfkarqn";
const cs = `postgres://postgres.${PROJECT_REF}:${encodeURIComponent(password)}@${host}:6543/postgres`;

async function main() {
  const c = new Client({ connectionString: cs });
  await c.connect();
  const tables = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name`);
  const columns = await c.query(`SELECT table_name, column_name, data_type, is_nullable, column_default, character_maximum_length, udt_name FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`);
  const fks = await c.query(`SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table_name, ccu.column_name AS foreign_column_name FROM information_schema.table_constraints AS tc JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage AS ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema='public' ORDER BY tc.table_name, kcu.column_name`);
  const pks = await c.query(`SELECT tc.table_name, kcu.column_name FROM information_schema.table_constraints AS tc JOIN information_schema.key_column_usage AS kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema='public' ORDER BY tc.table_name, kcu.ordinal_position`);
  const indexes = await c.query(`SELECT schemaname, tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`);

  const out: any = { tables: [], columns: {}, fks: {}, pks: {}, indexes: {} };
  for (const t of tables.rows) {
    out.tables.push(t.table_name);
    out.columns[t.table_name] = []; out.fks[t.table_name] = []; out.pks[t.table_name] = []; out.indexes[t.table_name] = [];
  }
  for (const col of columns.rows) if (out.columns[col.table_name]) out.columns[col.table_name].push(col);
  for (const fk of fks.rows) if (out.fks[fk.table_name]) out.fks[fk.table_name].push(fk);
  for (const pk of pks.rows) if (out.pks[pk.table_name]) out.pks[pk.table_name].push(pk.column_name);
  for (const idx of indexes.rows) if (out.indexes[idx.tablename]) out.indexes[idx.tablename].push(idx);

  writeFileSync(resolve(__dirname, "../tmp-schema.json"), JSON.stringify(out, null, 2));
  console.log(`Wrote ${tables.rows.length} tables to tmp-schema.json`);
  await c.end();
}
main().catch(e => { console.error(e); process.exit(1); });
