/**
 * Migrate ONE Appstle contract.
 *
 *   (no flags)              plan only — no calls that write
 *   --run                   create the Shopify contract + discounts + verify pricing. REVERSIBLE:
 *                           Appstle keeps billing, billing_source is untouched, the new contract is
 *                           inert. A leftover contract can simply be cancelled.
 *   --run --complete-swap   ALSO flip billing_source to shopcx and CANCEL the Appstle contract.
 *                           This is the irreversible half. Recovery is a status flip back on the
 *                           Appstle contract plus a cancel of ours — possible, but manual.
 */
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
  const completeSwap = process.argv.includes("--complete-swap");
  if (completeSwap && !run) {
    console.error("--complete-swap requires --run"); process.exit(1);
  }
  const r = await executeMigration(WS, id, ctx, {
    dryRun: !run,
    completeSwap,
    ...(ovIdx >= 0 ? { nextBillingDateOverride: process.argv[ovIdx + 1] } : {}),
  });
  console.log(JSON.stringify(r, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
