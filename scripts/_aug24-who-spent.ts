/** Aug 23-24: where the spend went (by ad account) and what the media buyer did. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  const { data: accts, error: ea } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_name,meta_account_id").eq("workspace_id", WS);
  if (ea) throw new Error(ea.message);
  const nameOf = new Map((accts ?? []).map((a) => [a.id as string, String(a.meta_account_name ?? a.meta_account_id)]));

  const { data: spend, error: es } = await admin.from("daily_meta_ad_spend")
    .select("snapshot_date,meta_ad_account_id,spend_cents,purchases,purchase_value_cents,clicks,impressions")
    .eq("workspace_id", WS).gte("snapshot_date", "2026-08-21").lte("snapshot_date", "2026-08-24")
    .order("snapshot_date");
  if (es) throw new Error(es.message);

  console.log("date         ad account                          spend   meta-purch  meta-rev   clicks");
  for (const r of spend ?? []) {
    console.log(
      `${r.snapshot_date}   ${(nameOf.get(String(r.meta_ad_account_id)) ?? "?").slice(0, 32).padEnd(32)}  $${(Number(r.spend_cents) / 100).toFixed(0).padStart(6)}   ${String(r.purchases).padStart(8)}   $${(Number(r.purchase_value_cents) / 100).toFixed(0).padStart(6)}   ${String(r.clicks).padStart(6)}`,
    );
  }

  const { data: acts, error: ia } = await admin.from("iteration_actions")
    .select("created_at,action_type,label,status,rationale,before_budget_cents,after_budget_cents")
    .eq("workspace_id", WS).gte("created_at", "2026-08-23T00:00:00-05:00")
    .order("created_at");
  if (ia) { console.log(`\niteration_actions: ${ia.message}`); return; }
  console.log(`\nmedia-buyer actions since Aug 23 (${(acts ?? []).length}):`);
  for (const a of acts ?? []) {
    const f = a.before_budget_cents != null ? `$${(Number(a.before_budget_cents) / 100).toFixed(0)}` : "—";
    const t = a.after_budget_cents != null ? `$${(Number(a.after_budget_cents) / 100).toFixed(0)}` : "—";
    console.log(`  ${String(a.created_at).slice(0, 16)}  ${String(a.action_type).padEnd(16)} ${f}→${t}  [${a.status}] ${String(a.label ?? "").slice(0, 28).padEnd(28)} ${String(a.rationale ?? "")}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
