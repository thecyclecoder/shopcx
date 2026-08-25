/** Ramp week (Aug 18-24) by ad account, plus August MTD blended CAC. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  const { data: accts, error: ea } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_name").eq("workspace_id", WS);
  if (ea) throw new Error(ea.message);
  const nameOf = new Map((accts ?? []).map((a) => [a.id as string, String(a.meta_account_name)]));

  for (const [label, from, to] of [["BASELINE Jul25–Aug17", "2026-07-25", "2026-08-17"], ["RAMP Aug18–Aug24", "2026-08-18", "2026-08-24"]] as const) {
    const { data, error } = await admin.from("daily_meta_ad_spend")
      .select("meta_ad_account_id,spend_cents,purchases,purchase_value_cents,clicks")
      .eq("workspace_id", WS).gte("snapshot_date", from).lte("snapshot_date", to);
    if (error) throw new Error(error.message);
    const agg: Record<string, { s: number; p: number; v: number; c: number }> = {};
    for (const r of data ?? []) {
      const k = nameOf.get(String(r.meta_ad_account_id)) ?? "?";
      agg[k] ??= { s: 0, p: 0, v: 0, c: 0 };
      agg[k].s += Number(r.spend_cents) / 100;
      agg[k].p += Number(r.purchases);
      agg[k].v += Number(r.purchase_value_cents) / 100;
      agg[k].c += Number(r.clicks);
    }
    console.log(`\n=== ${label} ===`);
    console.log("  account                       spend   meta-purch  meta-CPP  meta-ROAS   clicks  CVR");
    for (const [k, v] of Object.entries(agg).sort((a, b) => b[1].s - a[1].s)) {
      console.log(`  ${k.slice(0, 28).padEnd(28)} $${v.s.toFixed(0).padStart(6)}  ${String(v.p).padStart(9)}  ${(v.p ? "$" + (v.s / v.p).toFixed(0) : "—").padStart(8)}  ${(v.s ? (v.v / v.s).toFixed(2) : "—").padStart(9)}  ${String(v.c).padStart(6)}  ${v.c ? (100 * v.p / v.c).toFixed(1) + "%" : "—"}`);
    }
  }

  // August MTD blended CAC (Dylan's dashboard metric)
  const mtdTo = "2026-08-24";
  const { data: sp } = await admin.from("daily_meta_ad_spend").select("spend_cents")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-08-01").lte("snapshot_date", mtdTo);
  const { data: si } = await admin.from("daily_order_snapshots").select("new_subscription_count,one_time_count")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-08-01").lte("snapshot_date", mtdTo);
  const { data: az } = await admin.from("daily_amazon_order_snapshots").select("order_bucket,order_count")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-08-01").lte("snapshot_date", mtdTo);
  const S = (sp ?? []).reduce((x, r) => x + Number(r.spend_cents) / 100, 0);
  const W = (si ?? []).reduce((x, r) => x + Number(r.new_subscription_count) + Number(r.one_time_count), 0);
  const A = (az ?? []).filter((r) => ["one_time", "sns_checkout"].includes(String(r.order_bucket))).reduce((x, r) => x + Number(r.order_count), 0);
  console.log(`\n=== AUGUST MTD (Aug 1–${mtdTo}) ===`);
  console.log(`  spend $${S.toFixed(0)} · website ${W} + Amazon ${A} = ${W + A} new customers · blended CAC $${(S / (W + A)).toFixed(2)}`);
  console.log(`  run-rate spend $${(S / 24 * 31).toFixed(0)}/month · run-rate acquisition ${((W + A) / 24 * 31).toFixed(0)}/month`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
