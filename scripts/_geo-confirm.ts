/**
 * Confirm NO live adset (and no cohort template that mints new ones) reaches Puerto Rico.
 *
 * PR can enter a targeting spec four ways, not just `countries`:
 *   geo_locations.countries      → "PR"
 *   geo_locations.regions[]      → PR region keys (Meta lists PR municipalities as regions)
 *   geo_locations.cities[]       → San Juan 2515532, Bayamon 2514635, Guaynabo 2514908, ...
 *   geo_locations.country_groups → a group containing PR
 * So dump the WHOLE geo object rather than eyeballing `countries`.
 *
 * READ-ONLY.
 */
import "./_bootstrap";
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, listAdSets, getAdSetTargetingAndPixel } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

/** Any PR-flavoured key anywhere in a geo spec. PR region keys sit in the 42xx band; cities are 251xxxx. */
function findPR(geo: unknown): string[] {
  const hits: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    const s = String(node);
    if (/^PR$/i.test(s) || /puerto\s*rico/i.test(s)) hits.push(`${path}=${s}`);
  };
  walk(geo, "");
  return hits;
}

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");

  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("meta_account_id,meta_account_name").eq("workspace_id", WS);

  let checked = 0, flagged = 0;
  console.log("=== LIVE ADSETS — full geo spec ===");
  for (const a of accts ?? []) {
    let sets;
    try { sets = await listAdSets(token, String(a.meta_account_id)); } catch { continue; }
    for (const s of sets.filter((x) => x.effective_status === "ACTIVE")) {
      const t = await getAdSetTargetingAndPixel(token, s.id);
      const targeting = (t?.targeting ?? {}) as Record<string, unknown>;
      const geo = targeting.geo_locations ?? null;
      const excl = targeting.excluded_geo_locations ?? null;
      const hits = findPR(geo);
      checked += 1;
      if (hits.length) flagged += 1;
      console.log(`\n  ${String(a.meta_account_name)} · ${String(s.name).slice(0, 44)}`);
      console.log(`    geo_locations:          ${JSON.stringify(geo)}`);
      console.log(`    excluded_geo_locations: ${JSON.stringify(excl)}`);
      console.log(`    location_types:         ${JSON.stringify((geo as Record<string, unknown> | null)?.location_types ?? "—")}`);
      console.log(`    PR references:          ${hits.length ? "⚠ " + hits.join(", ") : "none ✅"}`);
    }
  }

  console.log("\n=== COHORT TEMPLATES (these mint every NEW test adset) ===");
  const { data: cohorts } = await admin.from("media_buyer_test_cohorts")
    .select("id,product_id,is_active,adset_template").eq("workspace_id", WS);
  for (const c of cohorts ?? []) {
    const tmpl = (c.adset_template ?? {}) as Record<string, unknown>;
    const geo = (tmpl.targeting as Record<string, unknown> | undefined)?.geo_locations ?? null;
    const hits = findPR(geo);
    checked += 1;
    if (hits.length) flagged += 1;
    console.log(`  cohort ${String(c.id).slice(0, 8)} active=${c.is_active}  geo=${JSON.stringify(geo)}  PR: ${hits.length ? "⚠ " + hits.join(", ") : "none ✅"}`);
  }

  console.log(`\n=== VERDICT ===`);
  console.log(`  targeting specs checked: ${checked} · containing any PR reference: ${flagged}`);
  console.log(flagged === 0
    ? `  ✅ Nothing targets Puerto Rico. No exclusion needed — adding one would be a no-op.`
    : `  ⚠ ${flagged} spec(s) reference PR — see above.`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
