// apply-landing-page-scout-migration — create the Landing Page Scout tables + private bucket
// (docs/brain/specs/landing-page-scout.md, Phase 1):
//   lander_snapshots        — per-chapter mobile snapshots of competitor + our landers
//   lander_recommendations  — vision-identified gaps → supervisable recs routed to build/optimizer
// Also ensures the private `lander-shots` Storage bucket exists (per-chapter screenshots).
// Idempotent (CREATE … IF NOT EXISTS + getBucket-before-create). Run via:
//   npx tsx scripts/apply-landing-page-scout-migration.ts
import { readFileSync } from "fs";
import { resolve } from "path";
import { pgClient, createAdminClient } from "./_bootstrap";
import { LANDER_SHOTS_BUCKET } from "../src/lib/landing-page-scout";

const MIGRATIONS = ["20260623130000_landing_page_scout.sql"];

async function main() {
  const c = pgClient();
  await c.connect();
  try {
    for (const file of MIGRATIONS) {
      await c.query(readFileSync(resolve(__dirname, "../supabase/migrations", file), "utf8"));
      console.log(`✓ applied ${file}`);
    }
    const { rows } = await c.query(
      "select table_name from information_schema.tables where table_name in ('lander_snapshots','lander_recommendations') order by table_name",
    );
    console.log("✓ tables present:", rows.map((r) => r.table_name));
  } finally {
    await c.end();
  }

  // Ensure the private screenshot bucket exists.
  const admin = createAdminClient();
  const { data: bucket } = await admin.storage.getBucket(LANDER_SHOTS_BUCKET);
  if (!bucket) {
    const { error } = await admin.storage.createBucket(LANDER_SHOTS_BUCKET, { public: false });
    if (error) throw new Error(`create bucket failed: ${error.message}`);
    console.log(`✓ created private bucket ${LANDER_SHOTS_BUCKET}`);
  } else {
    console.log(`✓ bucket ${LANDER_SHOTS_BUCKET} already exists`);
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
