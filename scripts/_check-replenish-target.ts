/** Which campaign did the replenish target, and did a publish job land? READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TARGET = "1319859a-d2d1-42e9-b125-fd6f00329a33";

async function main() {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 30 * 60_000).toISOString();

  const { data: acts } = await admin.from("director_activity")
    .select("created_at,action_kind,reason,metadata").eq("workspace_id", WS)
    .in("action_kind", ["media_buyer_replenished_test_cohort", "media_buyer_replenish_missing_config"])
    .gte("created_at", since).order("created_at", { ascending: false });
  console.log(`replenish activity in the last 30m: ${(acts ?? []).length}`);
  for (const a of acts ?? []) {
    console.log(`\n  ${String(a.created_at).slice(0, 19)}  ${a.action_kind}`);
    console.log(`    ${String(a.reason ?? "").slice(0, 260)}`);
    console.log(`    metadata: ${JSON.stringify(a.metadata).slice(0, 400)}`);
  }

  // `publish_status`, not `status` — see _watch-bianca-post.ts. Destructure `error` or a bad column
  // silently reads as zero rows.
  const { data: jobs, error: jobsErr } = await admin.from("ad_publish_jobs")
    .select("id,campaign_id,publish_status,origin,meta_adset_id,meta_ad_id,created_at")
    .eq("workspace_id", WS).gte("created_at", since).order("created_at", { ascending: false });
  if (jobsErr) throw new Error(`ad_publish_jobs: ${jobsErr.message}`);
  console.log(`\nad_publish_jobs created in the last 30m: ${(jobs ?? []).length}`);
  for (const j of jobs ?? []) {
    const mine = String(j.campaign_id) === TARGET;
    console.log(`  ${mine ? "◄ TARGET " : "         "}${String(j.created_at).slice(0, 19)} ${String(j.publish_status).padEnd(10)} campaign=${String(j.campaign_id).slice(0, 8)} adset=${j.meta_adset_id ?? "—"} ad=${j.meta_ad_id ?? "—"}`);
  }

  const { data: mine, error: mineErr } = await admin.from("ad_publish_jobs")
    .select("id,publish_status,meta_adset_id,meta_ad_id,created_at").eq("workspace_id", WS).eq("campaign_id", TARGET);
  if (mineErr) throw new Error(`ad_publish_jobs: ${mineErr.message}`);
  console.log(`\npublish jobs for the TARGET ad ever: ${(mine ?? []).length}`);
  for (const j of mine ?? []) console.log(`  ${String(j.created_at).slice(0, 19)} ${j.publish_status} adset=${j.meta_adset_id ?? "—"} ad=${j.meta_ad_id ?? "—"}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
