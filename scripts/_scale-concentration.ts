/**
 * Does a scale campaign concentrate spend onto ONE ad?
 *
 * CEO observation (2026-08-25): crowned winners were moved into a scale campaign manually and
 * "Meta only picked 1 ad and put like 95% of the spend on it". This measures that directly —
 * per-ad spend share inside every scaler/prospecting campaign we've run — and contrasts it with
 * the ABO test campaigns, where each adset holds its own budget.
 *
 * Then the other half of the question: when a TEST adset is scaled IN PLACE, does its CPA hold?
 *
 * READ-ONLY. DB-only, ZERO external API calls.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SINCE = "2026-06-01";

const $ = (c: number) => "$" + (c / 100).toFixed(0);

async function pageAll(admin: ReturnType<typeof createAdminClient>, level: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("meta_insights_daily")
      .select("level,meta_object_id,snapshot_date,spend_cents,purchases,revenue_cents,impressions,frequency")
      .eq("workspace_id", WS).eq("level", level).gte("snapshot_date", SINCE)
      .order("snapshot_date").range(off, off + 999);
    if (error) throw new Error(`meta_insights_daily(${level}): ${error.message}`);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

async function main() {
  const admin = createAdminClient();
  const ads = await pageAll(admin, "ad");
  const adsets = await pageAll(admin, "adset");
  console.log(`ad-level rows ${ads.length} · adset-level rows ${adsets.length} (since ${SINCE})\n`);

  // ── 1. Per-ad concentration inside each campaign ──────────────────────────
  // Map ad → its adset → its campaign via ad_publish_jobs where we can; otherwise group by adset.
  const { data: jobs } = await admin.from("ad_publish_jobs")
    .select("meta_ad_id,meta_adset_id,meta_campaign_id,campaign_id,origin,publish_status")
    .eq("workspace_id", WS);
  const adToCampaign = new Map<string, string>();
  const adToAdset = new Map<string, string>();
  for (const j of jobs ?? []) {
    if (j.meta_ad_id) {
      if (j.meta_campaign_id) adToCampaign.set(String(j.meta_ad_id), String(j.meta_campaign_id));
      if (j.meta_adset_id) adToAdset.set(String(j.meta_ad_id), String(j.meta_adset_id));
    }
  }

  // Aggregate lifetime spend per ad
  const adTot: Record<string, { s: number; p: number; r: number }> = {};
  for (const r of ads) {
    const k = String(r.meta_object_id);
    adTot[k] ??= { s: 0, p: 0, r: 0 };
    adTot[k].s += Number(r.spend_cents ?? 0);
    adTot[k].p += Number(r.purchases ?? 0);
    adTot[k].r += Number(r.revenue_cents ?? 0);
  }

  // Group ads by the adset we know them to be in
  const byAdset: Record<string, string[]> = {};
  for (const adId of Object.keys(adTot)) {
    const as = adToAdset.get(adId) ?? "(unmapped)";
    (byAdset[as] ??= []).push(adId);
  }

  console.log("=== SPEND CONCENTRATION: adsets holding ≥2 ads with spend ===");
  console.log("  (share = top ad's % of that adset's total ad spend)\n");
  const multi = Object.entries(byAdset)
    .map(([as, list]) => {
      const withSpend = list.filter((a) => adTot[a].s > 0);
      const tot = withSpend.reduce((x, a) => x + adTot[a].s, 0);
      const sorted = withSpend.sort((a, b) => adTot[b].s - adTot[a].s);
      return { as, n: withSpend.length, tot, top: sorted[0] ? adTot[sorted[0]].s : 0, sorted };
    })
    .filter((r) => r.n >= 2 && r.tot > 10000)
    .sort((a, b) => b.tot - a.tot);

  if (!multi.length) console.log("  none — every adset we have ad-level data for ran a single ad.");
  for (const m of multi.slice(0, 12)) {
    const share = (100 * m.top / m.tot).toFixed(0);
    console.log(`  adset ${m.as}  ${m.n} ads · total ${$(m.tot)} · TOP AD = ${share}% ${Number(share) >= 80 ? "◄ concentrated" : ""}`);
    for (const a of m.sorted.slice(0, 6)) {
      const t = adTot[a];
      console.log(`      ad ${a}  ${$(t.s).padStart(8)}  ${String(t.p).padStart(3)} purch  ${t.p ? "CPA " + $(t.s / t.p) : "—"}  (${(100 * t.s / m.tot).toFixed(0)}%)`);
    }
  }

  // ── 2. In-place scaling: did CPA hold as budget rose? ─────────────────────
  console.log("\n=== IN-PLACE SCALING: the crowned Tabs adsets, week by week ===");
  const CROWNED: Record<string, string> = {
    "120250143054030326": "MB Tabs · skeptic-bloat  ($150 → $1,337)",
    "120250066584430326": "MB Tabs — Test 02",
    "120250419137310326": "Superfood Tabs · Feel Lighter",
    "120249488919900682": "(other product) crowned",
    "120249298369230682": "(other product) crowned",
  };
  const byAdsetDay: Record<string, Array<{ d: string; s: number; p: number; r: number; f: number; i: number }>> = {};
  for (const r of adsets) {
    const k = String(r.meta_object_id);
    if (!(k in CROWNED)) continue;
    (byAdsetDay[k] ??= []).push({
      d: String(r.snapshot_date), s: Number(r.spend_cents ?? 0), p: Number(r.purchases ?? 0),
      r: Number(r.revenue_cents ?? 0), f: Number(r.frequency ?? 0), i: Number(r.impressions ?? 0),
    });
  }
  for (const [id, label] of Object.entries(CROWNED)) {
    const rows = (byAdsetDay[id] ?? []).sort((a, b) => a.d.localeCompare(b.d));
    if (!rows.length) { console.log(`\n  ${label} — no adset-level insight rows`); continue; }
    console.log(`\n  ${label}   [${id}]`);
    console.log(`    week starting   spend    purch   CPA      ROAS   freq`);
    // bucket into 7-day blocks from the first day
    const start = Date.parse(rows[0].d + "T12:00:00Z");
    const weeks: Record<number, { s: number; p: number; r: number; f: number[]; }> = {};
    for (const row of rows) {
      const w = Math.floor((Date.parse(row.d + "T12:00:00Z") - start) / (7 * 86400000));
      weeks[w] ??= { s: 0, p: 0, r: 0, f: [] };
      weeks[w].s += row.s; weeks[w].p += row.p; weeks[w].r += row.r;
      if (row.f) weeks[w].f.push(row.f);
    }
    for (const [w, v] of Object.entries(weeks)) {
      const d = new Date(start + Number(w) * 7 * 86400000).toISOString().slice(0, 10);
      const freq = v.f.length ? (v.f.reduce((a, b) => a + b, 0) / v.f.length).toFixed(2) : "—";
      console.log(`    ${d}   ${$(v.s).padStart(7)}  ${String(v.p).padStart(6)}   ${(v.p ? $(v.s / v.p) : "—").padStart(7)}  ${(v.s ? (v.r / v.s).toFixed(2) : "—").padStart(5)}   ${freq}`);
    }
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
