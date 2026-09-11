/** Migrate ONE Appstle contract. Dry-run by default; --run to actually create in Shopify. */
import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RULE = "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19";
async function main() {
  const id = process.argv[2];
  const run = process.argv.includes("--run");
  if (!id) { console.error("usage: _migrate-one.ts <appstleContractId> [--run]"); process.exit(1); }
  const { loadPricingContext, executeMigration } = await import("../src/lib/commerce/shopify-subscription-migrate");
  const ctx = await loadPricingContext(WS, RULE);
  const ovIdx = process.argv.indexOf("--next");
  const r = await executeMigration(WS, id, ctx, {
    dryRun: !run,
    ...(ovIdx >= 0 ? { nextBillingDateOverride: process.argv[ovIdx + 1] } : {}),
  });
  console.log(JSON.stringify(r, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
