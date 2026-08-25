/** Does the publish job the audit row claims actually exist? READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const JOB = "ebfb0789-3cf7-43e5-905e-7d4ce69f8969";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();

  // Unscoped by workspace — if it exists at all, find it.
  const { data, error } = await admin.from("ad_publish_jobs").select("*").eq("id", JOB).maybeSingle();
  if (error) console.log(`error: ${error.message}`);
  if (!data) {
    console.log(`❌ ad_publish_jobs ${JOB} DOES NOT EXIST — the audit row claims a write that did not land.`);
  } else {
    console.log(`✅ found:`);
    for (const [k, v] of Object.entries(data)) {
      if (v === null) continue;
      console.log(`  ${k.padEnd(26)} ${typeof v === "object" ? JSON.stringify(v).slice(0, 160) : String(v).slice(0, 160)}`);
    }
  }

  const { count } = await admin.from("ad_publish_jobs").select("id", { count: "exact", head: true }).eq("workspace_id", WS);
  console.log(`\ntotal ad_publish_jobs in workspace: ${count}`);

  const { data: recent } = await admin.from("ad_publish_jobs")
    .select("id,campaign_id,status,origin,created_at").eq("workspace_id", WS)
    .order("created_at", { ascending: false }).limit(5);
  console.log("most recent publish jobs:");
  for (const r of recent ?? []) {
    console.log(`  ${String(r.created_at).slice(0, 19)} ${String(r.status).padEnd(10)} origin=${r.origin ?? "—"} campaign=${String(r.campaign_id).slice(0, 8)} id=${String(r.id).slice(0, 8)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
