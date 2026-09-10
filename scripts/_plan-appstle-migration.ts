/**
 * Dry-run the Appstle→ShopCX migration over every snapshotted contract.
 *
 * Reads `appstle_contract_snapshots` + the catalog only. NO vendor calls, NO writes — so it is
 * free to run as often as we like while the rules are being tuned.
 *
 *   npx tsx scripts/_plan-appstle-migration.ts                     # population report
 *   npx tsx scripts/_plan-appstle-migration.ts --contract 28021424301   # one contract, in detail
 */
import { loadEnv } from "./_bootstrap";
loadEnv();

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PRICING_RULE_ID = "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19"; // Powder Drinks: Buy More, Save More
const money = (c: number) => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const { loadPricingContext, planMigration } = await import("../src/lib/commerce/shopify-subscription-migrate");
  const admin = createAdminClient();
  const one = process.argv.includes("--contract") ? process.argv[process.argv.indexOf("--contract") + 1] : null;

  const ctx = await loadPricingContext(WORKSPACE_ID, PRICING_RULE_ID);
  console.log(`rule: S&S ${ctx.snsPct}%  breaks ${JSON.stringify(ctx.breaks.map((b) => `${b.quantity}:${b.discount_pct}%`))}  consumables ${ctx.ruleProducts.size}\n`);

  const snaps: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    let q = admin.from("appstle_contract_snapshots").select("*").eq("workspace_id", WORKSPACE_ID);
    if (one) q = q.eq("appstle_contract_id", one);
    const { data } = await q.range(from, from + 999);
    if (!data?.length) break;
    snaps.push(...data);
    if (data.length < 1000) break;
  }

  // Only ACTIVE subs count toward the revenue delta; paused ones migrate but bill nothing now.
  const subs = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data } = await admin.from("subscriptions").select("shopify_contract_id, status")
      .eq("workspace_id", WORKSPACE_ID).range(from, from + 999);
    if (!data?.length) break;
    data.forEach((s: { shopify_contract_id: string; status: string }) => subs.set(String(s.shopify_contract_id), s.status));
    if (data.length < 1000) break;
  }

  if (one) {
    const plan = planMigration(snaps[0] as never, ctx);
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  let cur = 0, nw = 0, down = 0, unchanged = 0, up = 0, gfLines = 0, remapped = 0;
  const blocked: Record<string, number> = {};
  const droppedReasons: Record<string, number> = {};
  for (const s of snaps) {
    const plan = planMigration(s as never, ctx);
    plan.dropped.forEach((d) => { droppedReasons[d.reason] = (droppedReasons[d.reason] || 0) + 1; });
    plan.lines.forEach((l) => { if (l.grandfatherUnitCents > 0) gfLines++; if (l.remappedFrom) remapped++; });
    if (plan.blocked) { blocked[plan.blocked] = (blocked[plan.blocked] || 0) + 1; continue; }
    if (subs.get(String(plan.appstleContractId)) !== "active") continue;
    cur += plan.currentTotalCents; nw += plan.newTotalCents;
    const d = plan.newTotalCents - plan.currentTotalCents;
    if (d < -1) down++; else if (d > 1) up++; else unchanged++;
  }

  console.log(`snapshots planned: ${snaps.length}`);
  console.log(`\nBLOCKED: ${Object.values(blocked).reduce((a, b) => a + b, 0)}`);
  Object.entries(blocked).forEach(([k, v]) => console.log(`   ${k.padEnd(28)} ${v}`));
  console.log(`\nLINE REWRITES:`);
  Object.entries(droppedReasons).forEach(([k, v]) => console.log(`   dropped: ${k.padEnd(38)} ${v}`));
  console.log(`   variant remapped (relist drift)          ${remapped}`);
  console.log(`   grandfather locks                        ${gfLines}`);
  console.log(`\nPER-CYCLE REVENUE (active subs only):`);
  console.log(`   today            ${money(cur)}`);
  console.log(`   after migration  ${money(nw)}`);
  console.log(`   change           ${money(nw - cur)}   (${((nw - cur) / cur * 100).toFixed(1)}%)`);
  console.log(`\n   down ${down}   unchanged ${unchanged}   UP ${up}${up === 0 ? "   <- invariant holds" : "   <- INVARIANT VIOLATED"}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
