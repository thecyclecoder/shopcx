/**
 * _seed-angle-palette — the ONE generic seeder CLI for any advertised hero product's v3 angle
 * palette. Idempotent (upserts on the natural key). Drafts land at is_active=false so an owner
 * promotes them via /dashboard/marketing/ads/angles/[productId].
 *
 * Never five copy-pasted seed scripts — one file, one PROBLEM_LANES table (in
 * src/lib/ads/seed-angle-palette.ts), one call. Adding a 7th hero is one invocation.
 *
 * Run:
 *   npx tsx scripts/_seed-angle-palette.ts --product-id <uuid>
 *   npx tsx scripts/_seed-angle-palette.ts --product-handle amazing-coffee
 *   npx tsx scripts/_seed-angle-palette.ts --product-handle amazing-coffee --workspace-id <ws>
 *
 * Spec: docs/brain/specs/seed-angle-palette-remaining-5-products.md · Phase 1.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { resolveProductIdByHandle } from "../src/lib/product-intelligence";
import { seedHeadlinePatterns } from "../src/lib/ads/headline-patterns";
import { seedProductAnglePalette, formatSeededTable } from "../src/lib/ads/seed-angle-palette";
import { SUPERFOODS_WORKSPACE_ID } from "../src/lib/media-buyer/publish-identity";

interface CliArgs {
  productId: string | null;
  productHandle: string | null;
  workspaceId: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i]!;
    if (!t.startsWith("--")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) {
      args.set(t.slice(2, eq), t.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
      args.set(t.slice(2), argv[i + 1]!);
      i++;
    } else {
      args.set(t.slice(2), "");
    }
  }
  return {
    productId: args.get("product-id") ?? null,
    productHandle: args.get("product-handle") ?? null,
    workspaceId: args.get("workspace-id") ?? SUPERFOODS_WORKSPACE_ID,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.productId && !args.productHandle) {
    console.error("usage: npx tsx scripts/_seed-angle-palette.ts --product-id <uuid> | --product-handle <handle> [--workspace-id <uuid>]");
    process.exit(1);
  }
  const admin = createAdminClient();

  const productId = args.productId
    ?? await resolveProductIdByHandle(admin, args.workspaceId, args.productHandle!);
  if (!productId) {
    console.error(`no product found for handle=${args.productHandle} in workspace=${args.workspaceId}`);
    process.exit(1);
  }

  const n = await seedHeadlinePatterns(admin, args.workspaceId);
  console.log(`✓ seeded ${n} headline patterns (idempotent)`);

  const summary = await seedProductAnglePalette({
    admin,
    workspaceId: args.workspaceId,
    productId,
  });

  console.log(`\n── product ${productId} ──`);
  console.log(`  advertised: ${summary.advertised}`);
  console.log(`  ingredients: ${summary.ingredientNames.join(", ") || "(none)"}`);
  console.log(`  lanes considered: ${summary.lanesConsidered}`);
  console.log(`  lanes matched:    ${summary.lanesMatched}`);
  console.log(`  rows upserted:    ${summary.rowsUpserted}`);
  console.log(`  demand provider:  ${summary.provider}`);
  console.log(`\n${formatSeededTable(summary)}`);
  console.log(`\n→ Drafts land is_active=false. Promote via /dashboard/marketing/ads/angles/${productId}.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("ERR", e);
  process.exit(1);
});
