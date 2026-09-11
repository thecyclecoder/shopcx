/** Find (and with --apply, finish) Appstle→ShopCX migrations that stopped part-way. */
import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const apply = process.argv.includes("--apply");
  const { sweepIncompleteMigrations } = await import("../src/lib/commerce/shopify-subscription-migrate");
  const rows = await sweepIncompleteMigrations(WS, { apply });
  if (!rows.length) { console.log("no incomplete migrations."); return; }
  console.log(`incomplete migrations: ${rows.length}${apply ? "  (APPLYING)" : "  (dry run — pass --apply)"}\n`);
  for (const r of rows) {
    console.log(`${r.appstleContractId} -> ${r.newContractId}`);
    console.log(`   state=${r.state}  billing_source=${r.billingSource ?? "-"}`);
    console.log(`   ${r.action}`);
  }
  const half = rows.filter((r) => r.state === "half_swapped").length;
  if (half) console.log(`\n⚠️  ${half} HALF-SWAPPED — both engines believe they own these. Finish promptly.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
