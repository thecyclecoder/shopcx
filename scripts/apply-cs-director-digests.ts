// apply-cs-director-digests — create public.cs_director_digests (Phase 1 of
// docs/brain/specs/cs-director-storyline-digests-to-founder-with-bidirectional-reply.md).
// Idempotent (CREATE TABLE IF NOT EXISTS + IF NOT EXISTS indexes). Run against the pooler:
//   npx tsx scripts/apply-cs-director-digests.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATION = "20260920120000_cs_director_digests.sql";

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", MIGRATION), "utf8"));
    console.log(`✓ applied ${MIGRATION}`);

    const { rows: cols } = await c.query(
      `select column_name, data_type, is_nullable
         from information_schema.columns
        where table_schema='public' and table_name='cs_director_digests'
        order by ordinal_position`,
    );
    if (cols.length === 0) throw new Error("cs_director_digests table missing after migration");
    console.log(`✓ cs_director_digests has ${cols.length} column(s):`);
    for (const col of cols) console.log(`    - ${col.column_name} ${col.data_type} nullable=${col.is_nullable}`);

    const { rows: idx } = await c.query(
      `select indexname from pg_indexes
        where schemaname='public' and tablename='cs_director_digests'
        order by indexname`,
    );
    const idxNames = idx.map((r) => r.indexname);
    const need = [
      "cs_director_digests_workspace_created_idx",
      "cs_director_digests_workspace_period_idx",
    ];
    for (const n of need) {
      if (!idxNames.includes(n)) throw new Error(`index ${n} missing after migration`);
    }
    console.log(`✓ indexes present: ${need.join(", ")}`);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
