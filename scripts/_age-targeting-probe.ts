/**
 * What is Meta actually rejecting on Bianca's per-test ad sets, and what age targeting is live?
 *
 * Two threads point here: a parked repair (`media-buyer-replenish-sanitizes-legacy-advantage-age-
 * targeting`, whose fix spec never landed) and an approved repair "Fix Bianca per-test ad sets
 * rejected by Meta Advantage+ age controls". A replenish that mints an ad set Meta refuses is a
 * silent acquisition leak.
 *
 * READ-ONLY.
 */
import { createAdminClient } from "./_bootstrap";
import { getMetaUserToken, listAdSets, getAdSetTargetingAndPixel } from "../src/lib/meta-ads";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  // 1. the parked repair + any related jobs
  const { data: jobs } = await admin.from("agent_jobs")
    .select("id,kind,status,spec_slug,created_at,log_tail,instructions")
    .eq("workspace_id", WS).ilike("spec_slug", "%advantage%age%")
    .order("created_at", { ascending: false }).limit(5);
  console.log(`=== jobs matching advantage/age: ${(jobs ?? []).length} ===`);
  for (const j of jobs ?? []) {
    console.log(`\n  ${String(j.created_at).slice(0, 16)} ${j.kind} [${j.status}] ${j.spec_slug}`);
    if (j.log_tail) console.log(`     log tail: ${String(j.log_tail).slice(-900)}`);
  }

  // 2. publish jobs that never got an adset stamped — a mint Meta refused
  const { data: pj, error: pe } = await admin.from("ad_publish_jobs")
    .select("id,campaign_id,publish_status,meta_adset_id,created_at,create_adset_spec")
    .eq("workspace_id", WS).eq("origin", "media-buyer-test")
    .order("created_at", { ascending: false }).limit(15);
  if (pe) console.log(`\nad_publish_jobs: ${pe.message}`);
  else {
    console.log(`\n=== recent media-buyer-test publish jobs ===`);
    for (const j of pj ?? []) {
      const spec = (j.create_adset_spec ?? {}) as Record<string, unknown>;
      const tg = (spec.targeting ?? {}) as Record<string, unknown>;
      console.log(`  ${String(j.created_at).slice(0, 16)} ${String(j.publish_status).padEnd(10)} adset=${j.meta_adset_id ?? "NEVER MINTED"}  spec age ${tg.age_min ?? "?"}-${tg.age_max ?? "?"}`);
    }
  }

  // 3. director_activity mentioning age / advantage / rejected
  const { data: acts } = await admin.from("director_activity")
    .select("created_at,action_kind,reason,metadata").eq("workspace_id", WS)
    .or("reason.ilike.%age%,reason.ilike.%advantage%")
    .order("created_at", { ascending: false }).limit(12);
  console.log(`\n=== director_activity mentioning age/advantage: ${(acts ?? []).length} ===`);
  for (const a of acts ?? []) {
    if (!/age|advantage/i.test(String(a.reason))) continue;
    console.log(`  ${String(a.created_at).slice(0, 16)} ${a.action_kind}`);
    console.log(`     ${String(a.reason).slice(0, 300)}`);
  }

  // 4. what age targeting is LIVE on every active adset, and in every cohort template
  const token = await getMetaUserToken(WS);
  if (!token) return;
  const { data: accts } = await admin.from("meta_ad_accounts")
    .select("id,meta_account_id,meta_account_name").eq("workspace_id", WS);
  console.log(`\n=== LIVE adset age targeting ===`);
  for (const acct of accts ?? []) {
    let sets;
    try { sets = await listAdSets(token, String(acct.meta_account_id)); } catch { continue; }
    for (const s of sets.filter((x) => x.effective_status === "ACTIVE")) {
      const t = await getAdSetTargetingAndPixel(token, s.id);
      const tg = (t?.targeting ?? {}) as Record<string, unknown>;
      const auto = (tg.targeting_automation ?? {}) as Record<string, unknown>;
      console.log(`  ${String(acct.meta_account_name).slice(0, 20).padEnd(20)} ${String(s.name).slice(0, 38).padEnd(38)} age ${tg.age_min ?? "?"}-${tg.age_max ?? "?"}  advantage_audience=${auto.advantage_audience ?? "—"}`);
    }
  }

  console.log(`\n=== COHORT TEMPLATES (what NEW adsets are minted with) ===`);
  const { data: cohorts } = await admin.from("media_buyer_test_cohorts")
    .select("id,product_id,adset_template,is_active").eq("workspace_id", WS).eq("is_active", true);
  const { data: prods } = await admin.from("products").select("id,title").eq("workspace_id", WS);
  const title = new Map((prods ?? []).map((p) => [String(p.id), String(p.title)]));
  for (const c of cohorts ?? []) {
    const tmpl = (c.adset_template ?? {}) as Record<string, unknown>;
    const tg = (tmpl.targeting ?? {}) as Record<string, unknown>;
    const auto = (tg.targeting_automation ?? {}) as Record<string, unknown>;
    console.log(`  ${String(title.get(String(c.product_id)) ?? "?").padEnd(24)} age ${tg.age_min ?? "?"}-${tg.age_max ?? "?"}  advantage_audience=${auto.advantage_audience ?? "—"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
