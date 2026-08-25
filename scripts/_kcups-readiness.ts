/**
 * What does Amazing Coffee K-Cups need to enter the full ad flow?
 *
 * Walks the whole chain a product must satisfy, in order, and contrasts K-Cups against a product
 * that already works end-to-end (Superfood Tabs) so a missing prerequisite is obvious rather than
 * inferred:
 *   1. is_advertised            → the hero gate; also the Dahlia competitor→ad product dropdown
 *   2. landing_url / variants   → where the ad points, and the packshots the generator composes
 *   3. product media            → isolated packshots + hero/lifestyle imagery
 *   4. ad angles                → the copy source; replenish DEFERS a campaign with no angle_id
 *   5. competitors              → the research side (coffee competitors also serve K-Cups per CEO)
 *   6. ready creatives          → the cold bin Bianca replenishes from
 *   7. test cohort              → active, with a testing campaign + adset template
 *   8. inventory                → can we actually ship it
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const KCUPS = "f081a8ee-530b-4789-8654-bd57c3a51569";
const TABS = "221d272d-a6c5-4a5d-86ff-ac693926c992";   // the working control
const COFFEE = "ea433e56-0aa4-4b46-9107-feb11f77f533"; // sibling — competitors are shared

const ok = (b: boolean) => (b ? "✅" : "❌");

async function main() {
  const admin = createAdminClient();

  // 1. the product rows
  const { data: prods } = await admin.from("products").select("*").eq("workspace_id", WS)
    .in("id", [KCUPS, TABS, COFFEE]);
  const byId = new Map((prods ?? []).map((p) => [String(p.id), p]));
  const k = byId.get(KCUPS), t = byId.get(TABS);
  if (!k) { console.log("no K-Cups product row"); return; }

  console.log("=== 1. HERO GATE (is_advertised) — this is the dropdown filter ===");
  for (const [label, p] of [["K-Cups", k], ["Superfood Tabs (control)", t]] as const) {
    console.log(`  ${ok(p?.is_advertised === true)} ${String(label).padEnd(26)} is_advertised=${p?.is_advertised}`);
  }

  console.log("\n=== 2. PRODUCT ROW FIELDS ===");
  const interesting = ["title", "handle", "landing_url", "product_url", "status", "description"];
  for (const f of interesting) {
    if (!(f in k)) continue;
    const kv = k[f], tv = t?.[f];
    console.log(`  ${f.padEnd(16)} K-Cups: ${String(kv ?? "—").slice(0, 60).padEnd(62)} Tabs: ${String(tv ?? "—").slice(0, 40)}`);
  }

  // 3. media
  for (const [label, tbl, col] of [["product_media", "product_media", "product_id"]] as const) {
    const { data, error } = await admin.from(tbl).select("*").eq("workspace_id", WS).in(col, [KCUPS, TABS]);
    if (error) { console.log(`\n  (${label}: ${error.message})`); continue; }
    const kc = (data ?? []).filter((r) => String(r[col]) === KCUPS);
    const tc = (data ?? []).filter((r) => String(r[col]) === TABS);
    console.log(`\n=== 3. MEDIA (${label}) ===`);
    console.log(`  ${ok(kc.length > 0)} K-Cups ${kc.length} row(s) · Tabs ${tc.length} row(s)`);
    for (const r of kc.slice(0, 6)) console.log(`      ${JSON.stringify(r).slice(0, 150)}`);
  }

  // 4. angles
  // NB: there is no `angle` column — the shape is hook_slug / meta_headline / lead_benefit_anchor.
  // Selecting a non-existent column returns an ERROR with data=null, which reads as "0 rows" if you
  // only destructure `data`. That silently reported 0 angles for BOTH products while 165 rows existed.
  const { data: angles, error: angleErr } = await admin.from("product_ad_angles")
    .select("id,product_id,hook_slug,meta_headline,is_active,status,created_at")
    .eq("workspace_id", WS).in("product_id", [KCUPS, TABS]);
  if (angleErr) throw new Error(`product_ad_angles: ${angleErr.message}`);
  const ka = (angles ?? []).filter((a) => String(a.product_id) === KCUPS);
  const ta = (angles ?? []).filter((a) => String(a.product_id) === TABS);
  console.log(`\n=== 4. AD ANGLES (the copy source — replenish DEFERS a campaign with no angle_id) ===`);
  console.log(`  ${ok(ka.length > 0)} K-Cups ${ka.length} angle(s) · Tabs ${ta.length} angle(s)`);
  for (const a of ka.slice(0, 12)) console.log(`      ${String(a.hook_slug ?? "").padEnd(20)} ${String(a.meta_headline ?? "").slice(0, 52)}  [${a.status ?? "—"}${a.is_active ? "" : ", INACTIVE"}]`);

  // 5. competitors
  const { data: comps, error: ce } = await admin.from("competitors")
    .select("id,product_id,brand_name,is_active").eq("workspace_id", WS);
  if (!ce) {
    const kcomp = (comps ?? []).filter((c) => String(c.product_id) === KCUPS);
    const ccomp = (comps ?? []).filter((c) => String(c.product_id) === COFFEE);
    console.log(`\n=== 5. COMPETITORS ===`);
    console.log(`  K-Cups-scoped ${kcomp.length} · Amazing-Coffee-scoped ${ccomp.length} · workspace total ${(comps ?? []).length}`);
    console.log(`  (CEO: coffee competitors also apply to K-Cups, so a shared/unscoped pool is fine)`);
  }

  // 6. ready creatives
  const { data: camps } = await admin.from("ad_campaigns")
    .select("id,product_id,status,audience_temperature,angle_id,landing_url").eq("workspace_id", WS)
    .in("product_id", [KCUPS, TABS]).neq("status", "archived");
  const kcamp = (camps ?? []).filter((c) => String(c.product_id) === KCUPS);
  console.log(`\n=== 6. CREATIVES IN THE BIN ===`);
  console.log(`  ${ok(kcamp.length > 0)} K-Cups ${kcamp.length} · Tabs ${(camps ?? []).filter((c) => String(c.product_id) === TABS).length}`);
  for (const c of kcamp.slice(0, 8)) console.log(`      ${String(c.id).slice(0, 8)} ${c.status} temp=${c.audience_temperature ?? "untagged"} angle=${c.angle_id ? "yes" : "NONE"}`);

  // 7. cohort
  const { data: cohorts } = await admin.from("media_buyer_test_cohorts")
    .select("id,product_id,is_active,test_meta_campaign_id,per_test_daily_budget_cents,daily_test_ceiling_cents,adset_template")
    .eq("workspace_id", WS).eq("product_id", KCUPS);
  console.log(`\n=== 7. TEST COHORT ===`);
  for (const c of cohorts ?? []) {
    console.log(`  ${ok(!!c.is_active)} cohort ${String(c.id).slice(0, 8)} active=${c.is_active} campaign=${c.test_meta_campaign_id ?? "—"} $${Number(c.per_test_daily_budget_cents) / 100}/test ceiling $${Number(c.daily_test_ceiling_cents) / 100} template=${c.adset_template ? "set" : "MISSING"}`);
  }

  // 8. inventory
  const { data: inv } = await admin.from("inventory_levels")
    .select("sku,location,on_hand").eq("workspace_id", WS).eq("product_id", KCUPS);
  const byLoc: Record<string, number> = {};
  for (const r of inv ?? []) byLoc[String(r.location)] = (byLoc[String(r.location)] ?? 0) + Number(r.on_hand ?? 0);
  console.log(`\n=== 8. INVENTORY ===`);
  console.log(`  ${Object.entries(byLoc).map(([l, v]) => `${l} ${v}`).join(" · ") || "no rows resolved to this product_id"}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
