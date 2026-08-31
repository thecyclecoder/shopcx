/**
 * End-to-end proof the tax-code fix is live: run the REAL subscription tax quote
 * (the same path a renewal uses) for Laura's NY supplement sub and a coffee sub.
 * Before the fix: Laura's quote was $8.44. After: should be $0.00 for NY supplements.
 */
import "./_bootstrap";
import { createAdminClient } from "./_bootstrap";
import { quoteSubscriptionTax } from "../src/lib/avalara-subscription";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const LAURA_SUB = "e0ba9592";

async function main() {
  const admin = createAdminClient();
  const { data: subs, error } = await admin.from("subscriptions")
    .select("id,customer_id,status,items,avalara_quote_tax_cents,avalara_quote_address")
    .eq("workspace_id", WS).eq("status", "active").not("avalara_quote_tax_cents", "is", null).limit(60);
  if (error) throw new Error(`subscriptions: ${error.message}`);

  const laura = (subs ?? []).find((s) => String(s.id).startsWith(LAURA_SUB));
  const others = (subs ?? []).filter((s) => s.id !== laura?.id && Number(s.avalara_quote_tax_cents) > 0).slice(0, 4);
  const targets = [laura, ...others].filter(Boolean) as Array<Record<string, unknown>>;

  console.log(`sub        state  titles                              stored quote → fresh quote`);
  for (const s of targets) {
    const addr = (s.avalara_quote_address ?? {}) as Record<string, unknown>;
    const items = (s.items ?? []) as Array<Record<string, unknown>>;
    const titles = items.map((i) => String(i.title)).join("+").slice(0, 34);
    const before = Number(s.avalara_quote_tax_cents ?? 0);
    const fresh = await quoteSubscriptionTax(WS, String(s.id));
    const after = fresh?.tax_cents ?? -1;
    const delta = after >= 0 ? after - before : 0;
    const mark = after === 0 && before > 0 ? "  ← now exempt" : delta < 0 ? "  ← lower" : "";
    console.log(`${String(s.id).slice(0, 8)}   ${String(addr.region ?? "?").padEnd(5)}  ${titles.padEnd(36)} $${(before / 100).toFixed(2)} → ${after < 0 ? "(no quote)" : `$${(after / 100).toFixed(2)}`}${mark}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e instanceof Error ? e.message : JSON.stringify(e)); process.exit(1); });
