/**
 * Puerto Rico: are we paying for it, and does it convert?
 *
 * CEO observation (2026-08-25): "I'm being served ads and I'm in Puerto Rico. Historically PR
 * doesn't convert — and PR most likely needs Spanish ads, which we don't have yet."
 *
 * Two questions:
 *   1. Are our live adsets actually targeting PR? Meta's `countries:["US"]` INCLUDES Puerto Rico
 *      (PR is a US territory in Meta's geo taxonomy) unless it is explicitly excluded.
 *   2. What does PR actually do for us — order volume, AOV, and share of the base?
 *
 * READ-ONLY (Meta reads are list-only; no writes).
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, listAdSets, getAdSetTargetingAndPixel } from "../src/lib/meta-ads";
import { bucketOrder } from "../src/lib/order-bucketing";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

function stateOf(addr: unknown): string | null {
  if (!addr || typeof addr !== "object") return null;
  const a = addr as Record<string, unknown>;
  const v = a.province_code ?? a.provinceCode ?? a.province ?? a.state ?? a.region_code ?? a.region;
  const c = a.country_code ?? a.countryCode ?? a.country;
  if (typeof c === "string" && /^(PR|Puerto Rico)$/i.test(c)) return "PR";
  return typeof v === "string" ? v.toUpperCase() : null;
}

async function main() {
  const admin = createAdminClient();

  // ── 1. What do our LIVE adsets actually target? ──────────────────────────
  const token = await getMetaUserToken(WS);
  const { data: accts } = await admin.from("meta_ad_accounts").select("meta_account_id,meta_account_name").eq("workspace_id", WS);
  console.log("=== LIVE ADSET GEO TARGETING ===");
  if (token) {
    for (const a of accts ?? []) {
      let sets;
      try { sets = await listAdSets(token, String(a.meta_account_id)); } catch { continue; }
      for (const s of sets.filter((x) => x.effective_status === "ACTIVE")) {
        const t = await getAdSetTargetingAndPixel(token, s.id);
        const geo = (t?.targeting?.geo_locations ?? null) as Record<string, unknown> | null;
        const countries = JSON.stringify(geo?.countries ?? geo?.country_groups ?? "—");
        const excluded = JSON.stringify((t?.targeting as Record<string, unknown> | undefined)?.excluded_geo_locations ?? "none");
        console.log(`  ${String(a.meta_account_name).slice(0, 22).padEnd(22)} ${String(s.name).slice(0, 40).padEnd(40)} countries=${countries} excluded_geo=${excluded}`);
      }
    }
    console.log(`\n  ⚠ Meta's countries:["US"] INCLUDES Puerto Rico. Excluding it requires an explicit`);
    console.log(`    excluded_geo_locations entry (region key) — "US" alone does NOT carve it out.`);
  } else {
    console.log("  no Meta token");
  }

  // ── 2. Does PR convert? ──────────────────────────────────────────────────
  const rows: Array<{ shipping_address: unknown; billing_address: unknown; total_cents: number | null; source_name: string | null; tags: string | null; subscription_id: string | null; created_at: string }> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await admin.from("orders")
      .select("shipping_address,billing_address,total_cents,source_name,tags,subscription_id,created_at")
      .eq("workspace_id", WS).gte("created_at", "2025-01-01").range(off, off + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as typeof rows));
    if (!data || data.length < 1000) break;
  }
  console.log(`\n=== ORDERS BY STATE (since 2025-01-01, ${rows.length} orders) ===`);

  const agg: Record<string, { acq: number; renew: number; rev: number }> = {};
  for (const r of rows) {
    const st = stateOf(r.shipping_address) ?? stateOf(r.billing_address) ?? "(unknown)";
    const b = bucketOrder(r);
    agg[st] ??= { acq: 0, renew: 0, rev: 0 };
    if (b === "new_sub" || b === "one_time") { agg[st].acq += 1; agg[st].rev += Number(r.total_cents ?? 0) / 100; }
    else if (b === "recurring") agg[st].renew += 1;
  }
  const totalAcq = Object.values(agg).reduce((x, v) => x + v.acq, 0);
  const sorted = Object.entries(agg).sort((a, b) => b[1].acq - a[1].acq);

  console.log("  state    acquisitions   share    renewals   acq AOV   renew-per-acq");
  for (const [st, v] of sorted.slice(0, 12)) {
    console.log(`  ${st.padEnd(9)} ${String(v.acq).padStart(11)}  ${(100 * v.acq / totalAcq).toFixed(1).padStart(5)}%  ${String(v.renew).padStart(9)}   ${(v.acq ? "$" + (v.rev / v.acq).toFixed(0) : "—").padStart(7)}   ${v.acq ? (v.renew / v.acq).toFixed(2) : "—"}`);
  }

  const pr = agg["PR"];
  console.log(`\n=== PUERTO RICO ===`);
  if (!pr) {
    console.log(`  ZERO orders ever recorded with a PR address (since 2025-01-01).`);
  } else {
    const rank = sorted.findIndex(([s]) => s === "PR") + 1;
    console.log(`  acquisitions ${pr.acq} (${(100 * pr.acq / totalAcq).toFixed(2)}% of all acquisition, rank #${rank} of ${sorted.length})`);
    console.log(`  renewals ${pr.renew} · renew-per-acq ${pr.acq ? (pr.renew / pr.acq).toFixed(2) : "—"} (vs all-states ${(Object.values(agg).reduce((x, v) => x + v.renew, 0) / totalAcq).toFixed(2)})`);
    console.log(`  acq AOV ${pr.acq ? "$" + (pr.rev / pr.acq).toFixed(0) : "—"} · lifetime acq revenue $${pr.rev.toFixed(0)}`);
  }

  // US population share benchmark: PR is ~3.2M of ~335M ≈ 0.96% of the US+territories population.
  console.log(`\n  benchmark: PR is ~0.96% of US+territory population.`);
  if (pr) {
    const share = 100 * pr.acq / totalAcq;
    console.log(`  our PR acquisition share is ${share.toFixed(2)}% → ${(share / 0.96).toFixed(2)}x population parity ${share < 0.96 ? "(UNDER-indexes)" : "(over-indexes)"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
