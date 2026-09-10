import { loadEnv } from "./_bootstrap";
loadEnv();
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const RULE = "ed8ae5b4-aba9-4ad6-9e1f-2ef504819f19";
async function main() {
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const M = await import("../src/lib/commerce/shopify-subscription-migrate");
  const admin = createAdminClient();
  const ctx = await M.loadPricingContext(WS, RULE);
  console.log("sns", ctx.snsPct, "breaks", JSON.stringify(ctx.breaks), "ruleProducts", ctx.ruleProducts.size, "variants", ctx.variantBySku.size);
  const { data: rule } = await admin.from("pricing_rules").select("*").eq("id", RULE).single();
  console.log("RULE ROW:", JSON.stringify(rule));

  const snaps: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data } = await admin.from("appstle_contract_snapshots").select("*").eq("workspace_id", WS).range(from, from+999);
    if (!data?.length) break; snaps.push(...data); if (data.length < 1000) break;
  }
  const subs = new Map<string, any>();
  for (let from = 0; ; from += 1000) {
    const { data } = await admin.from("subscriptions").select("id, shopify_contract_id, status, next_billing_date, billing_source").eq("workspace_id", WS).range(from, from+999);
    if (!data?.length) break; data.forEach((s:any)=>subs.set(String(s.shopify_contract_id), s)); if (data.length<1000) break;
  }

  let nonRuleGF = 0, nonRuleGFcontracts = new Set<string>(), nonRuleLines = 0;
  let truncLoss = 0, truncLossLines = 0, truncLossContracts = new Set<string>(), maxTruncLoss = 0;
  let nullVariantGid = 0, protZero = 0, protQtyGt1 = 0;
  let dupVariantInPlan = 0, dupVariantMismatch = 0;
  const dupExamples: string[] = [];
  let gfExceedsStd = 0, negFinal = 0, hugeGF = 0;
  const hugeGFex: string[] = [];
  let deliveryLoss = 0;
  const nonRuleEx: string[] = [];
  for (const s of snaps) {
    const plan = M.planMigration(s as any, ctx);
    const sub = subs.get(String(s.appstle_contract_id));
    const active = sub?.status === "active";
    for (const l of plan.lines) {
      if (!l.isProtection && !l.onRule) { nonRuleLines++; if (l.grandfatherUnitCents > 0) { nonRuleGF++; nonRuleGFcontracts.add(s.appstle_contract_id); if (nonRuleEx.length<5) nonRuleEx.push(`${s.appstle_contract_id} sku=${l.sku} gf=${l.grandfatherUnitCents} base=${l.baseCents} cur=${l.currentUnitCents}`);} }
      if (String(l.shopifyVariantId) === "null" || !l.shopifyVariantId) nullVariantGid++;
      if (l.isProtection && l.currentUnitCents === 0) protZero++;
      if (l.grandfatherUnitCents > l.standardUnitCents) gfExceedsStd++;
      if (l.finalUnitCents < 0) negFinal++;
      if (l.grandfatherUnitCents > 2000) { hugeGF++; if (hugeGFex.length<8) hugeGFex.push(`${s.appstle_contract_id} sku=${l.sku} gf=${(l.grandfatherUnitCents/100).toFixed(2)} base=${(l.baseCents/100).toFixed(2)} std=${(l.standardUnitCents/100).toFixed(2)} cur=${(l.currentUnitCents/100).toFixed(2)} qty=${l.quantity}`); }
      // truncation: real shopify line total vs plan
      if (l.onRule && l.quantity > 1) {
        const { lineTotalCents } = M.shopifyLineMath(l.baseCents, l.quantity, ctx.snsPct, plan.breakPct, l.grandfatherUnitCents);
        const planned = l.finalUnitCents * l.quantity;
        const d = lineTotalCents - planned;
        if (d !== 0) { truncLossLines++; truncLoss += d; truncLossContracts.add(s.appstle_contract_id); if (Math.abs(d) > maxTruncLoss) maxTruncLoss = Math.abs(d); }
      }
    }
    // duplicate variant in plan
    const vs = plan.lines.map(l=>l.shopifyVariantId);
    if (new Set(vs).size !== vs.length) {
      dupVariantInPlan++;
      // do the two dup lines differ in what verify would compare?
      const byV = new Map<string, any[]>();
      for (const l of plan.lines) { const a = byV.get(l.shopifyVariantId) ?? []; a.push(l); byV.set(l.shopifyVariantId, a); }
      for (const [v, arr] of byV) if (arr.length>1) {
        const differ = new Set(arr.map(a=>`${a.baseCents}/${a.finalUnitCents}`)).size > 1;
        if (differ) { dupVariantMismatch++; if (dupExamples.length<6) dupExamples.push(`${s.appstle_contract_id} v=${v} ${arr.map(a=>`q${a.quantity} base${a.baseCents} fin${a.finalUnitCents}`).join(" | ")}`); }
      }
    }
    if (active && (s.delivery_price_cents ?? 0) > 0) deliveryLoss += s.delivery_price_cents;
  }
  console.log({ nonRuleLines, nonRuleGF, nonRuleGFcontracts: nonRuleGFcontracts.size, nonRuleEx });
  console.log({ truncLossLines, truncLossContracts: truncLossContracts.size, truncLossCentsTotal: truncLoss, maxTruncLossCents: maxTruncLoss });
  console.log({ nullVariantGid, protZero, gfExceedsStd, negFinal, hugeGF, hugeGFex });
  console.log({ dupVariantInPlan, dupVariantMismatch, dupExamples });
  console.log("delivery revenue at risk per cycle (active):", (deliveryLoss/100).toFixed(2));
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
