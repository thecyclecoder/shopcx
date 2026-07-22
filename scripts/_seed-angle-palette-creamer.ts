/**
 * _seed-angle-palette-creamer — thin wrapper that delegates to the generic seeder for the
 * Amazing Creamer product id. The enumeration lives in one place (src/lib/ads/seed-angle-palette.ts
 * PROBLEM_LANES) so every hero product's palette lands on the same schema.
 *
 * Kept as a named script for muscle-memory; identical behavior to:
 *   npx tsx scripts/_seed-angle-palette.ts --product-id 61a4490e-cb2a-4f65-9613-faab40f0b153
 *
 * Run: npx tsx scripts/_seed-angle-palette-creamer.ts
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { seedHeadlinePatterns } from "../src/lib/ads/headline-patterns";
import { seedProductAnglePalette, formatSeededTable } from "../src/lib/ads/seed-angle-palette";
import { SUPERFOODS_WORKSPACE_ID } from "../src/lib/media-buyer/publish-identity";

const CREAMER = "61a4490e-cb2a-4f65-9613-faab40f0b153";

async function main() {
  const admin = createAdminClient();
  const n = await seedHeadlinePatterns(admin, SUPERFOODS_WORKSPACE_ID);
  console.log(`✓ seeded ${n} headline patterns`);

  const summary = await seedProductAnglePalette({
    admin,
    workspaceId: SUPERFOODS_WORKSPACE_ID,
    productId: CREAMER,
  });

  console.log(`✓ seeded ${summary.rowsUpserted} Amazing Creamer angles (matched ${summary.lanesMatched}/${summary.lanesConsidered} lanes; provider=${summary.provider})`);
  console.log(`\n${formatSeededTable(summary)}`);
  console.log(`\n→ Drafts land is_active=false. Promote via /dashboard/marketing/ads/angles/${CREAMER}.`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e); process.exit(1); });
