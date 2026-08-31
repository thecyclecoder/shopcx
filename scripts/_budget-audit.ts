/**
 * LIVE budget audit: every ad account → campaign → adset, with committed daily budget,
 * joined to trailing-7d Meta performance so a trim decision has evidence behind it.
 *
 * Reads LIVE Meta state (budgets drift from our record), plus daily_meta_ad_spend for actuals.
 * READ-ONLY — lists and reads only, never writes to Meta.
 *
 * Run: npx tsx scripts/_budget-audit.ts
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, listCampaigns, listAdSets } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TRAIL_FROM = "2026-08-18"; // the ramp window
const TRAIL_TO = "2026-08-24";

// Phase 1 plan + current policy rails
const PHASE1_DAILY = 55000 / 30;
const CROWN_CPA = 240, HOLD_CPA = 450, SLOW_KILL_CPA = 600;

const money = (cents: number) => "$" + (cents / 100).toFixed(0);

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no active Meta token for this workspace");

  const { data: accts, error } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_id,meta_account_name,is_active").eq("workspace_id", WS);
  if (error) throw new Error(error.message);

  // trailing-7d actual spend + Meta-reported purchases per account
  const { data: spend } = await admin.from("daily_meta_ad_spend")
    .select("meta_ad_account_id,spend_cents,purchases,purchase_value_cents")
    .eq("workspace_id", WS).gte("snapshot_date", TRAIL_FROM).lte("snapshot_date", TRAIL_TO);
  const perf: Record<string, { s: number; p: number; v: number }> = {};
  for (const r of spend ?? []) {
    const k = String(r.meta_ad_account_id);
    perf[k] ??= { s: 0, p: 0, v: 0 };
    perf[k].s += Number(r.spend_cents) / 100;
    perf[k].p += Number(r.purchases);
    perf[k].v += Number(r.purchase_value_cents) / 100;
  }

  let committedActive = 0;
  const rows: Array<{ acct: string; camp: string; adset: string; daily: number; status: string; level: string }> = [];

  for (const a of accts ?? []) {
    const accountId = String(a.meta_account_id);
    const label = String(a.meta_account_name ?? accountId);
    const p = perf[String(a.id)];
    const cpa = p && p.p ? p.s / p.p : null;

    console.log(`\n${"═".repeat(96)}`);
    console.log(`AD ACCOUNT  ${label}   (act_${accountId})${a.is_active ? "" : "   [INACTIVE in our DB]"}`);
    if (p) {
      console.log(`  trailing 7d: spend $${p.s.toFixed(0)} · Meta purchases ${p.p} · Meta CPP ${cpa ? "$" + cpa.toFixed(0) : "—"} · ROAS ${(p.v / p.s).toFixed(2)}`);
    } else {
      console.log(`  trailing 7d: no spend recorded`);
    }

    let campaigns;
    try {
      campaigns = await listCampaigns(token, accountId);
    } catch (e) {
      console.log(`  ⚠ could not list campaigns: ${e instanceof Error ? e.message : String(JSON.stringify(e))}`);
      continue;
    }
    if (!campaigns.length) { console.log("  (no active/paused campaigns)"); continue; }

    const adsets = await listAdSets(token, accountId);
    const byCampaign = new Map<string, typeof adsets>();
    for (const s of adsets) {
      const k = String(s.campaign_id);
      byCampaign.set(k, [...(byCampaign.get(k) ?? []), s]);
    }

    for (const c of campaigns.sort((x, y) => (x.effective_status === "ACTIVE" ? -1 : 1))) {
      const cbo = c.daily_budget ? Number(c.daily_budget) : 0;
      const kids = byCampaign.get(c.id) ?? [];
      const liveKids = kids.filter((s) => s.effective_status === "ACTIVE");
      const aboSum = liveKids.reduce((x, s) => x + (s.daily_budget ? Number(s.daily_budget) : 0), 0);
      const committed = cbo || aboSum;
      const live = c.effective_status === "ACTIVE";
      if (live) committedActive += committed;

      console.log(`\n  ${live ? "▶" : "⏸"} CAMPAIGN  ${c.name}`);
      console.log(`     status ${c.effective_status ?? c.status} · ${c.objective ?? "—"} · ${cbo ? `CBO daily ${money(cbo)}` : `ABO (adset budgets)`} · ${liveKids.length}/${kids.length} adsets active · committed ${money(committed)}/day`);

      for (const s of kids.sort((x, y) => Number(y.daily_budget ?? 0) - Number(x.daily_budget ?? 0))) {
        const b = s.daily_budget ? Number(s.daily_budget) : 0;
        const on = s.effective_status === "ACTIVE";
        const age = s.created_time ? Math.round((Date.parse("2026-08-25T12:00:00Z") - Date.parse(s.created_time)) / 86400000) : null;
        console.log(`       ${on ? "●" : "○"} ${String(s.name).slice(0, 52).padEnd(52)} ${(b ? money(b) + "/day" : "—").padStart(10)}  ${(s.effective_status ?? "").padEnd(18)} ${age !== null ? age + "d old" : ""}`);
        if (on && b) rows.push({ acct: label, camp: c.name, adset: String(s.name), daily: b, status: String(s.effective_status), level: cbo ? "CBO" : "ABO" });
      }
    }
  }

  console.log(`\n${"═".repeat(96)}`);
  console.log("COMMITTED DAILY BUDGET (active campaigns only)");
  console.log(`  total committed        ${money(committedActive)}/day  →  $${(committedActive / 100 * 30).toFixed(0)}/month`);
  console.log(`  Phase 1 plan           $${PHASE1_DAILY.toFixed(0)}/day  →  $55,000/month`);
  const over = committedActive / 100 - PHASE1_DAILY;
  console.log(`  ${over > 0 ? `⚠ OVER plan by $${over.toFixed(0)}/day ($${(over * 30).toFixed(0)}/month)` : `✅ under plan by $${(-over).toFixed(0)}/day`}`);

  console.log(`\n  largest active adset budgets:`);
  for (const r of rows.sort((a, b) => b.daily - a.daily).slice(0, 15)) {
    console.log(`    ${money(r.daily).padStart(7)}/day  ${r.acct.slice(0, 22).padEnd(22)} ${r.adset.slice(0, 46)}`);
  }
  console.log(`\n  policy rails: crown ≤$${CROWN_CPA} CPP · hold ≤$${HOLD_CPA} · slow-kill ≥$${SLOW_KILL_CPA}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
