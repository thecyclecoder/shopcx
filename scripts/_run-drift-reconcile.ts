import { loadEnv } from "./_bootstrap";
loadEnv();
import { reconcileShopcxDrift } from "../src/lib/commerce/shopcx-drift-reconciler";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.argv.includes("--apply");
async function main() {
  const r = await reconcileShopcxDrift(WS, { apply: APPLY });
  console.log(`checked=${r.checked} repaired=${r.repaired} drift=${r.drift.length} errors=${r.errors.length}`);
  for (const d of r.drift) {
    console.log(`\n  [${d.kind}]${d.repaired ? " (REPAIRED)" : ""} ${d.contractId}`);
    console.log(`     ours=${d.ours}  shopify=${d.shopify}`);
    console.log(`     ${d.detail}`);
  }
  for (const e of r.errors) console.log("  ERR", e);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
