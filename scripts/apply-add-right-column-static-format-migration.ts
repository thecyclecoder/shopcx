// apply-add-right-column-static-format-migration — update ad_videos.format
// column comment to include `right_column_1x1`
// (dahlia-produces-3-placement-multi-copy-creative-pack Phase 1). Idempotent
// (COMMENT ON COLUMN replaces the comment). Run against the pooler:
//   npx tsx scripts/apply-add-right-column-static-format-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const MIGRATIONS = ["20261022120000_add_right_column_static_format.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      `select col_description('public.ad_videos'::regclass, ordinal_position) as comment
         from information_schema.columns
        where table_schema='public' and table_name='ad_videos' and column_name='format'`,
    );
    const comment: string = rows[0]?.comment ?? "";
    const ok = comment.includes("right_column_1x1");
    console.log(`✓ ad_videos.format comment mentions right_column_1x1: ${ok}`);
    if (!ok) process.exit(1);
  } finally {
    await c.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
