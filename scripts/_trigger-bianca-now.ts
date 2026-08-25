/**
 * Trigger a media-buyer (Bianca) pass so the unblocked Superfood Tabs creative posts.
 *
 * Pre-flight FIRST — re-verifies live state rather than trusting the earlier analysis:
 *   · the target ad is still postable + still the product-scoped cold candidate
 *   · the cohort genuinely has an open explore slot under the DEPLOYED arithmetic
 *     (crowns revoked ⇒ hasActiveWinner=false ⇒ target reverts to 4; the code fix in this
 *      branch is NOT deployed yet and is not needed for this particular unblock)
 *   · no kill switch is down, policy is armed
 *   · no unfinished media-buyer job already in flight (the cadence's own coverage rule)
 *
 * Pass --apply to insert the job. Default is a dry run.
 */
import { createAdminClient } from "./_bootstrap";
import { listReadyToTest } from "../src/lib/ads/ready-to-test";

const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const TARGET_AD = "1319859a-d2d1-42e9-b125-fd6f00329a33";
const TABS_PRODUCT = "221d272d-a6c5-4a5d-86ff-ac693926c992";
const APPLY = process.argv.includes("--apply");

const ok = (b: boolean) => (b ? "✅" : "❌");

async function main() {
  const admin = createAdminClient();
  let blocked = false;

  // 1. policy armed?
  const { data: pol } = await admin.from("iteration_policies")
    .select("id,mode,status,per_object_cooldown_hours").eq("workspace_id", WS).eq("status", "active").limit(1).maybeSingle();
  const armed = pol?.mode === "armed";
  console.log(`${ok(armed)} policy mode = ${pol?.mode}`);
  if (!armed) blocked = true;

  // 2. kill switches
  const { data: sw } = await admin.from("kill_switches").select("key,enabled,note").eq("workspace_id", WS);
  const down = (sw ?? []).filter((s) => s.enabled === false && /media|buyer|bianca|ad|publish/i.test(String(s.key)));
  console.log(`${ok(down.length === 0)} kill switches — ${down.length ? down.map((d) => d.key).join(", ") + " DOWN" : "none relevant are down"}`);
  if (down.length) blocked = true;

  // 3. the ad is still the cold candidate for its product
  const res = await listReadyToTest(admin, { workspaceId: WS, productId: TABS_PRODUCT, temperature: "cold" });
  const rows = (Array.isArray(res) ? res : (res as { readyToTest?: Array<{ ad_campaign_id: string }> }).readyToTest ?? []);
  const present = rows.some((r) => r.ad_campaign_id === TARGET_AD);
  console.log(`${ok(present)} target ad in the product-scoped cold bin (${rows.length} row(s))`);
  if (!present) blocked = true;

  // 4. open explore slot under the DEPLOYED arithmetic
  const { data: cohort } = await admin.from("media_buyer_test_cohorts")
    .select("id,test_meta_campaign_id,per_test_daily_budget_cents,is_active")
    .eq("workspace_id", WS).eq("product_id", TABS_PRODUCT).maybeSingle();
  const { data: liveAdsets } = await admin.from("meta_adsets")
    .select("meta_adset_id,effective_status").eq("workspace_id", WS)
    .eq("meta_campaign_id", String(cohort?.test_meta_campaign_id));
  const live = (liveAdsets ?? []).filter((a) => String(a.effective_status).toUpperCase() === "ACTIVE").length;
  const { data: activeCrowns } = await admin.from("media_buyer_crowned_winners")
    .select("test_meta_adset_id").eq("workspace_id", WS).eq("exploit_exhausted", false);
  const hasActiveWinner = (activeCrowns ?? []).length > 0;
  const target = hasActiveWinner ? 2 : 4;
  const deficit = Math.max(0, target - live);
  console.log(`${ok(deficit > 0)} explore slot — ${live} live · target ${target} (hasActiveWinner=${hasActiveWinner}) ⇒ deficit ${deficit}`);
  console.log(`   new adset would mint at $${Number(cohort?.per_test_daily_budget_cents ?? 0) / 100}/day`);
  if (deficit <= 0) blocked = true;

  // 5. is a job already in flight?
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: jobs } = await admin.from("agent_jobs")
    .select("id,status,created_at,kind").eq("workspace_id", WS).eq("kind", "media-buyer")
    .gte("created_at", since).order("created_at", { ascending: false });
  const inFlight = (jobs ?? []).filter((j) => ["queued", "running", "pending", "needs_approval"].includes(String(j.status)));
  console.log(`${ok(inFlight.length === 0)} no media-buyer job already in flight (${(jobs ?? []).length} in the last 24h)`);
  for (const j of jobs ?? []) console.log(`      ${String(j.created_at).slice(0, 16)} ${j.status} ${j.id}`);
  if (inFlight.length) { console.log("   → an in-flight job will already cover this; not inserting a duplicate."); blocked = true; }

  console.log(`\n${blocked ? "❌ BLOCKED — not triggering" : "✅ CLEAR TO TRIGGER"}`);
  if (blocked || !APPLY) {
    if (!blocked && !APPLY) console.log("   (dry run — pass --apply to insert the job)");
    return;
  }

  const { data: ins, error } = await admin.from("agent_jobs").insert({
    workspace_id: WS,
    spec_slug: "media-buyer:workspace",
    kind: "media-buyer",
    instructions: JSON.stringify({ meta_ad_account_id: null }),
  }).select("id,status,created_at").single();
  if (error) throw new Error(`agent_jobs insert failed: ${error.message}`);
  console.log(`\n✅ enqueued media-buyer job ${ins.id} (status ${ins.status})`);
  console.log("   the box worker picks up kind='media-buyer' on its next poll.");
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
