/**
 * Audit every ACTIVE test cohort's adset_template against the ad account it actually mints into.
 *
 * Custom audiences and pixels are PER-AD-ACCOUNT on Meta. A cohort carrying another account's
 * exclusion-audience ids cannot exclude anything — the mint either errors or silently ships a cold
 * test contaminated with existing customers, which poisons the very signal the test exists to read.
 *
 * Suspicion: the K-Cups cohort (Amazing Coffee & Creamer, act_…984) carries exclusion audiences
 * ending …326, which is the Superfood Tabs account's object-id suffix.
 *
 * Resolves each audience id against Meta to find its true owning account. READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const token = await getMetaUserToken(WS);
  if (!token) throw new Error("no Meta token");

  const { data: cohorts } = await admin.from("media_buyer_test_cohorts")
    .select("*").eq("workspace_id", WS).eq("is_active", true);
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_id,meta_account_name").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));
  const acct = new Map((accts ?? []).map((a) => [String(a.id), a]));

  const audienceOwner = new Map<string, string>();
  async function ownerOf(id: string): Promise<string> {
    if (audienceOwner.has(id)) return audienceOwner.get(id)!;
    const j = await fetch(
      `https://graph.facebook.com/v21.0/${id}?fields=id,name,account_id&access_token=${encodeURIComponent(token)}`,
    ).then((r) => r.json()) as Record<string, unknown>;
    const owner = j.error ? `ERROR ${JSON.stringify((j.error as Record<string, unknown>).message ?? j.error).slice(0, 80)}` : `act_${j.account_id}`;
    audienceOwner.set(id, owner);
    return owner;
  }

  let bad = 0;
  for (const c of (cohorts ?? []).sort((a, b) => String(title.get(String(a.product_id))).localeCompare(String(title.get(String(b.product_id)))))) {
    const a = acct.get(String(c.meta_ad_account_id));
    const expected = `act_${a?.meta_account_id}`;
    const tmpl = (c.adset_template ?? {}) as Record<string, unknown>;
    const targeting = (tmpl.targeting ?? {}) as Record<string, unknown>;
    const excl = ((targeting.excluded_custom_audiences ?? []) as Array<Record<string, unknown>>).map((x) => String(x.id));

    console.log(`\n${title.get(String(c.product_id)) ?? c.product_id}`);
    console.log(`  mints into      ${a?.meta_account_name} (${expected})`);
    // the template key is camelCase `pixelId`, not `pixel_id`
    console.log(`  pixelId         ${tmpl.pixelId ?? tmpl.pixel_id ?? "MISSING"}`);
    console.log(`  cohort columns  purchaser=${c.excluded_purchaser_audience_id ?? "—"} all=${c.excluded_all_customers_audience_id ?? "—"}`);

    if (!excl.length) { console.log(`  ⚠ no excluded_custom_audiences on the template`); continue; }
    for (const id of excl) {
      const owner = await ownerOf(id);
      const good = owner === expected;
      if (!good) bad += 1;
      console.log(`  ${good ? "✅" : "❌"} audience ${id} owned by ${owner}${good ? "" : `  ← WRONG ACCOUNT (expected ${expected})`}`);
    }
  }

  console.log(`\n${bad === 0 ? "✅ every cohort's exclusion audiences belong to its own ad account." : `❌ ${bad} audience reference(s) point at the wrong ad account — those cohorts cannot exclude existing customers.`}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
