/**
 * PF050144 is silently rejected by Avalara → falls back to P0000000 (fully taxable).
 * Find the supplement code Avalara actually ACCEPTS. A code is accepted iff the response
 * echoes it back unchanged; a rejected code comes back as P0000000 / taxCodeId 4316.
 */
import "./_bootstrap";
import { createTransaction } from "../src/lib/avalara";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SHIP_TO = { line1: "2566 South Avenue", city: "Syracuse", region: "NY", postalCode: "13207", country: "US" };
const TODAY = "2026-08-31";

const CANDIDATES = ["PF050144", "PF050100", "PF050101", "PF050102", "PC040100", "PC040101", "P0000000"];

async function main() {
  console.log(`ship-to Syracuse NY · $105.48 line\n`);
  console.log(`code       accepted?  tax      rate    verdict`);
  for (const code of CANDIDATES) {
    const res = await createTransaction(WS, {
      code: `PROBE-${code}-${TODAY}`,
      customerCode: "taxcode-probe",
      date: TODAY, commit: false, type: "SalesOrder", shipTo: SHIP_TO,
      lines: [{ number: "1", amount: 105.48, quantity: 4, taxCode: code, description: `probe ${code}` }],
    });
    if (!res.success) { console.log(`${code.padEnd(10)} ERROR      ${res.error}`); continue; }
    const raw = res.raw as { lines?: Array<{ taxCode?: string }> } | undefined;
    const echoed = raw?.lines?.[0]?.taxCode ?? "?";
    const accepted = echoed === code;
    const tax = (res.totalTaxCents ?? 0) / 100;
    const rate = (tax / 105.48) * 100;
    const verdict = !accepted ? `REJECTED → ${echoed}` : tax === 0 ? "accepted · FULLY EXEMPT" : "accepted";
    console.log(`${code.padEnd(10)} ${accepted ? "yes" : "NO "}        $${tax.toFixed(2).padStart(5)}  ${rate.toFixed(2).padStart(5)}%  ${verdict}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
