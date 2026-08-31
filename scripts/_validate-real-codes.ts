/**
 * Validate the CORRECT Avalara codes — chosen by product description, then rate-checked
 * (not chosen by rate). Confirms each is accepted (echoed back unchanged, not degraded to
 * P0000000) and shows what NY actually charges.
 *
 * Supplements (CEO 2026-08-31: Creatine, Superfood Tabs, Ashwavana, + the two gummies)
 * Non-supplements: coffee, creamer, K-Cups → groceries, currently miscoded as CLOTHING.
 */
import "./_bootstrap";
import { createTransaction } from "../src/lib/avalara";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TODAY = "2026-08-31";

const ADDRS = [
  { label: "Syracuse NY (Laura)", a: { line1: "2566 South Avenue", city: "Syracuse", region: "NY", postalCode: "13207", country: "US" } },
  { label: "Austin TX", a: { line1: "1100 Congress Ave", city: "Austin", region: "TX", postalCode: "78701", country: "US" } },
  { label: "Los Angeles CA", a: { line1: "200 N Spring St", city: "Los Angeles", region: "CA", postalCode: "90012", country: "US" } },
];

const CODES = [
  { code: "PF050144", what: "CURRENT supplement code (invalid)" },
  { code: "PF050700", what: "dietary supplements (supplement facts on label)" },
  { code: "PF050720", what: "other dietary supplements" },
  { code: "PC040100", what: "CURRENT coffee code (= CLOTHING)" },
  { code: "PF050002", what: "food for home consumption / basic groceries" },
];

async function main() {
  for (const { label, a } of ADDRS) {
    console.log(`\n════ ${label} ════`);
    console.log(`code        accepted  tax on $105.48   rate     what`);
    for (const c of CODES) {
      const res = await createTransaction(WS, {
        code: `VALIDATE-${c.code}-${a.region}-${TODAY}`,
        customerCode: "code-validation", date: TODAY, commit: false, type: "SalesOrder", shipTo: a,
        lines: [{ number: "1", amount: 105.48, quantity: 4, taxCode: c.code, description: c.what }],
      });
      if (!res.success) { console.log(`${c.code.padEnd(11)} ERROR ${res.error}`); continue; }
      const raw = res.raw as { lines?: Array<{ taxCode?: string }> } | undefined;
      const echoed = raw?.lines?.[0]?.taxCode ?? "?";
      const ok = echoed === c.code;
      const tax = (res.totalTaxCents ?? 0) / 100;
      console.log(`${c.code.padEnd(11)} ${(ok ? "yes" : `NO→${echoed}`).padEnd(9)} $${tax.toFixed(2).padStart(6)}         ${((tax / 105.48) * 100).toFixed(2).padStart(5)}%   ${c.what}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
