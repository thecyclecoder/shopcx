/**
 * Are the three un-excluded adsets FATIGUED, or still fresh?
 *
 * Decides retire-vs-reset: if a creative is fatigued, resetting its measurement clock buys a stale
 * asset a second run and the slot is better spent on something new. If it is still fresh, retiring
 * throws away a proven performer to gamble on an unproven one — resetting is cheaper.
 *
 * Uses the system's OWN fatigue signals where they exist (iteration_scorecards_daily:
 * fatigue_score / ctr_declining / frequency_rising) plus the raw weekly trend from
 * meta_insights_daily, because the scorecards only cover what the engine has scored.
 *
 * Fatigue looks like: frequency RISING, CTR FALLING, CPA worsening at CONSTANT budget.
 * NOT fatigue: CPA worsening because budget was scaled (broader reach, worse marginal audience) —
 * frequency typically FALLS in that case, which is the tell.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TARGETS: Record<string, string> = {
  "120250066584430326": "MB Tabs — Test 02        (the crown candidate, $186 CPA)",
  "120250143054030326": "MB Tabs · skeptic-bloat  ($245 CPA, was scaled to $1,337/day)",
};
const $ = (c: number) => "$" + (c / 100).toFixed(0);

async function main() {
  const admin = createAdminClient();

  // Raw daily insights → weekly trend.
  const rows: Array<{ meta_object_id: string; snapshot_date: string; spend_cents: number; purchases: number; impressions: number; clicks: number; ctr: number; frequency: number }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("meta_insights_daily")
      .select("meta_object_id,snapshot_date,spend_cents,purchases,impressions,clicks,ctr,frequency")
      .eq("workspace_id", WS).eq("level", "adset").in("meta_object_id", Object.keys(TARGETS))
      .range(off, off + 999);
    if (error) throw new Error(`meta_insights_daily: ${error.message}`);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }

  for (const [id, label] of Object.entries(TARGETS)) {
    const mine = rows.filter((r) => String(r.meta_object_id) === id).sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    if (!mine.length) { console.log(`\n${label}\n  no insight rows`); continue; }

    console.log(`\n${label}`);
    console.log(`  week start    spend  purch     CPA    CTR%   freq   daily budget implied`);
    const start = Date.parse(mine[0].snapshot_date + "T12:00:00Z");
    const weeks: Record<number, { s: number; p: number; imp: number; clk: number; f: number[]; days: number }> = {};
    for (const r of mine) {
      const w = Math.floor((Date.parse(r.snapshot_date + "T12:00:00Z") - start) / (7 * 86400000));
      weeks[w] ??= { s: 0, p: 0, imp: 0, clk: 0, f: [], days: 0 };
      weeks[w].s += Number(r.spend_cents ?? 0);
      weeks[w].p += Number(r.purchases ?? 0);
      weeks[w].imp += Number(r.impressions ?? 0);
      weeks[w].clk += Number(r.clicks ?? 0);
      if (Number(r.frequency)) weeks[w].f.push(Number(r.frequency));
      if (Number(r.spend_cents) > 0) weeks[w].days += 1;
    }
    const series: Array<{ d: string; ctr: number; freq: number; cpa: number | null; perDay: number }> = [];
    for (const [w, v] of Object.entries(weeks)) {
      const d = new Date(start + Number(w) * 7 * 86400000).toISOString().slice(0, 10);
      const ctr = v.imp ? (100 * v.clk) / v.imp : 0;
      const freq = v.f.length ? v.f.reduce((a, b) => a + b, 0) / v.f.length : 0;
      const cpa = v.p ? v.s / v.p : null;
      const perDay = v.days ? v.s / v.days : 0;
      series.push({ d, ctr, freq, cpa, perDay });
      console.log(`  ${d}  ${$(v.s).padStart(7)} ${String(v.p).padStart(6)}  ${(cpa ? $(cpa) : "—").padStart(6)}  ${ctr.toFixed(2).padStart(6)}  ${freq.toFixed(2).padStart(5)}   ${$(perDay)}/day`);
    }

    // Fatigue verdict from the shape, using only weeks with real delivery.
    const real = series.filter((x) => x.perDay > 1000);
    if (real.length >= 2) {
      const first = real[0], last = real[real.length - 1];
      const freqRising = last.freq > first.freq * 1.15;
      const ctrFalling = last.ctr < first.ctr * 0.85;
      const budgetGrew = last.perDay > first.perDay * 1.5;
      console.log(`\n  frequency ${first.freq.toFixed(2)} → ${last.freq.toFixed(2)}  ${freqRising ? "RISING ⚠" : "not rising ✓"}`);
      console.log(`  CTR       ${first.ctr.toFixed(2)}% → ${last.ctr.toFixed(2)}%  ${ctrFalling ? "FALLING ⚠" : "not falling ✓"}`);
      console.log(`  budget    ${$(first.perDay)}/day → ${$(last.perDay)}/day  ${budgetGrew ? "SCALED (CPA drift here is scale, not fatigue)" : "flat"}`);
      const fatigued = freqRising && ctrFalling;
      console.log(`  ► ${fatigued ? "FATIGUED — retiring is justified" : "NOT fatigued — the creative still has life; resetting the clock preserves it"}`);
    }
  }

  // The engine's own scored fatigue, where it exists.
  const { data: sc, error: se } = await admin.from("iteration_scorecards_daily")
    .select("object_id,snapshot_date,fatigue_score,ctr_declining,frequency_rising,days_live")
    .eq("workspace_id", WS).in("object_id", Object.keys(TARGETS))
    .order("snapshot_date", { ascending: false }).limit(12);
  console.log(`\n=== the engine's own fatigue scoring (iteration_scorecards_daily) ===`);
  if (se) console.log(`  ${se.message}`);
  else if (!(sc ?? []).length) console.log(`  no scored rows for these adsets`);
  for (const r of sc ?? []) {
    console.log(`  ${r.snapshot_date} ${String(r.object_id).slice(-10)} fatigue=${Number(r.fatigue_score).toFixed(2)} ctr_declining=${r.ctr_declining} freq_rising=${r.frequency_rising} days_live=${r.days_live}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
