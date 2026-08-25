/** Did the triggered Bianca pass post the target ad? READ-ONLY. */
import { createAdminClient } from "./_bootstrap";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TARGET_AD = "1319859a-d2d1-42e9-b125-fd6f00329a33";
const JOB = process.argv[2] ?? "c89e6a8d-0b2b-4087-b8be-b0ceb4ee27bf";

async function main() {
  const admin = createAdminClient();

  const { data: job } = await admin.from("agent_jobs")
    .select("id,status,created_at,updated_at,log_tail").eq("id", JOB).maybeSingle();
  console.log(`job ${JOB}: ${job?.status ?? "?"}  created ${String(job?.created_at).slice(0, 16)}  updated ${String(job?.updated_at).slice(0, 16)}`);
  if (job?.log_tail) console.log(`  log tail: ${String(job.log_tail).slice(-500)}`);

  // NB: the column is `publish_status`, NOT `status`, and there is no `error` column. Selecting a
  // column that does not exist returns an ERROR with data=null — which, if you only destructure
  // `data`, silently reads as "0 rows" and reports a successful publish as a failure. It did exactly
  // that on 2026-08-25. Always destructure `error` too.
  const { data: jobs, error: jobsErr } = await admin.from("ad_publish_jobs")
    .select("id,publish_status,publish_active,origin,meta_adset_id,meta_ad_id,meta_creative_id,created_at")
    .eq("workspace_id", WS).eq("campaign_id", TARGET_AD).order("created_at");
  if (jobsErr) throw new Error(`ad_publish_jobs: ${jobsErr.message}`);
  console.log(`\npublish jobs for the target ad: ${(jobs ?? []).length}`);
  for (const j of jobs ?? []) {
    console.log(`  ${String(j.created_at).slice(0, 16)}  ${String(j.publish_status).padEnd(10)} active=${j.publish_active}  origin=${j.origin ?? "—"}  adset=${j.meta_adset_id ?? "—"}  ad=${j.meta_ad_id ?? "—"}  creative=${j.meta_creative_id ?? "—"}`);
  }

  const { data: acts } = await admin.from("director_activity")
    .select("created_at,action_kind,reason").eq("workspace_id", WS)
    .gte("created_at", new Date(Date.now() - 3600_000).toISOString())
    .ilike("action_kind", "%media_buyer%").order("created_at", { ascending: false }).limit(10);
  console.log(`\nmedia-buyer activity in the last hour: ${(acts ?? []).length}`);
  for (const a of acts ?? []) console.log(`  ${String(a.created_at).slice(0, 16)} ${String(a.action_kind).padEnd(44)} ${String(a.reason ?? "").slice(0, 90)}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
