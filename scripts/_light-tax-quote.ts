/**
 * Laura Light — pull a FRESH live Avalara quote for her exact order.
 * CEO 2026-08-31: "if avalara says it should be taxed, we have to trust that."
 *
 * This is a QUOTE (commit:false → SalesOrder), so it does NOT create a filable transaction.
 * One API call. Runs the real line (Superfood Tabs, PF050144) to her real Syracuse address,
 * and a control line (Amazing Coffee, PC040100 food) to see whether NY treats them differently.
 */
import "./_bootstrap";
import { createTransaction } from "../src/lib/avalara";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const SHIP_TO = { line1: "2566 South Avenue", city: "Syracuse", region: "NY", postalCode: "13207", country: "US" };
const TODAY = "2026-08-31";

async function main() {
  console.log(`ship-to: ${SHIP_TO.line1}, ${SHIP_TO.city} ${SHIP_TO.region} ${SHIP_TO.postalCode}\n`);

  const cases: Array<{ label: string; taxCode: string; amount: number }> = [
    { label: "Superfood Tabs (her actual line)", taxCode: "PF050144", amount: 105.48 },
    { label: "control: coffee / food code", taxCode: "PC040100", amount: 105.48 },
    { label: "control: general tangible goods", taxCode: "P0000000", amount: 105.48 },
  ];

  for (const c of cases) {
    const res = await createTransaction(WS, {
      code: `QUOTE-LIGHT-${c.taxCode}-${TODAY}`,
      customerCode: "llight9977@gmail.com",
      date: TODAY,
      commit: false,
      type: "SalesOrder",
      shipTo: SHIP_TO,
      lines: [{ number: "1", amount: c.amount, quantity: 4, taxCode: c.taxCode, description: c.label, itemCode: "SC-TABS-BERRY" }],
    });
    if (!res.success) {
      console.log(`${c.taxCode}  ${c.label}\n   ❌ ${res.error}\n`);
      continue;
    }
    const tax = (res.totalTaxCents ?? 0) / 100;
    const rate = c.amount > 0 ? (tax / c.amount) * 100 : 0;
    console.log(`${c.taxCode}  ${c.label}`);
    console.log(`   tax $${tax.toFixed(2)} on $${c.amount.toFixed(2)}  →  ${rate.toFixed(2)}%  ${tax === 0 ? "← EXEMPT" : ""}`);
    console.log(`   lines: ${JSON.stringify(res.lines ?? [])}\n`);
  }

  console.log(`For reference, SHOPCX168 was charged $8.44 on $105.48 (8.00%).`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
