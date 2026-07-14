/**
 * Ads-supervisor fix — adset id 120252360719970184 (Amazing Coffee): the live
 * creative carries no Life-Force-8 language in its headline / primary text.
 *
 * Consumes fix-spec `ads-supervisor-fix-fdc11e10-live-ad-lf8-120252360719970184`
 * (authored by `runAdsSupervisorPass` in `src/lib/ads-supervisor.ts`, deterministic
 * action per the spec: "locate the ad_campaigns row wired to this adset — join
 * ad_publish_jobs on adset id — rewrite via Dahlia's next generate (edit the
 * creative_brief lead)").
 *
 * Concretely: locate the ad_publish_jobs row(s) whose meta_adset_id matches the
 * target adset, resolve their ad_campaigns.angle_id, LF8-scan every referenced
 * product_ad_angles row using the same hasAnyLf8() predicate the supervisor uses,
 * and (with --apply) flip is_active=false on any LF8-thin active angle. Deactivating
 * removes that angle from the product-intelligence adAngles feed
 * (`.eq('is_active', true)` in getProductIntelligence), so Dahlia's next generate
 * for this cohort won't reuse it — satisfying the spec's "next generate should
 * carry LF8 language on line 1" goal without touching Meta directly (the supervisor's
 * north-star: never move spend / place ads from the pass; a consumed fix-spec is
 * the only channel that can, and this deactivate is the minimum-blast-radius
 * mutation that achieves the goal).
 *
 * Dry-run by default. Run: `npx tsx scripts/fix-live-ad-lf8-120252360719970184.ts [--apply]`.
 */
import "./_bootstrap";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasAnyLf8 } from "@/lib/ads-supervisor";

const ADSET_ID = "120252360719970184";
const APPLY = process.argv.includes("--apply");

interface PubJobRow {
  id: string;
  workspace_id: string;
  campaign_id: string;
  meta_adset_id: string | null;
  meta_ad_id: string | null;
  publish_status: string | null;
}

interface CampaignRow {
  id: string;
  name: string | null;
  angle_id: string | null;
  status: string | null;
  product_id: string | null;
}

interface AngleRow {
  id: string;
  hook_one_liner: string | null;
  lead_benefit_anchor: string | null;
  meta_headline: string | null;
  meta_primary_text: string | null;
  meta_description: string | null;
  is_active: boolean;
}

async function main() {
  const admin = createAdminClient();

  const { data: pubJobs, error: pubErr } = await admin
    .from("ad_publish_jobs")
    .select("id, workspace_id, campaign_id, meta_adset_id, meta_ad_id, publish_status")
    .eq("meta_adset_id", ADSET_ID);
  if (pubErr) {
    console.error("ad_publish_jobs read failed:", pubErr.message);
    process.exit(1);
  }
  const jobs = (pubJobs ?? []) as PubJobRow[];
  if (!jobs.length) {
    console.log(`No ad_publish_jobs found with meta_adset_id='${ADSET_ID}' — nothing to fix.`);
    return;
  }

  console.log(`Found ${jobs.length} ad_publish_job(s) for adset ${ADSET_ID}:`);
  for (const j of jobs) {
    console.log(`  job ${j.id} · campaign ${j.campaign_id} · meta_ad ${j.meta_ad_id ?? "(none)"} · status=${j.publish_status ?? "(none)"}`);
  }

  const campaignIds = [...new Set(jobs.map((j) => j.campaign_id).filter(Boolean))];
  const workspaceId = jobs[0].workspace_id;

  const { data: campaigns, error: cErr } = await admin
    .from("ad_campaigns")
    .select("id, name, angle_id, status, product_id")
    .in("id", campaignIds);
  if (cErr) {
    console.error("ad_campaigns read failed:", cErr.message);
    process.exit(1);
  }
  const camps = (campaigns ?? []) as CampaignRow[];
  console.log(`\nResolved ${camps.length} ad_campaigns row(s):`);
  for (const c of camps) {
    console.log(`  campaign ${c.id} · name=${c.name ?? "(none)"} · angle_id=${c.angle_id ?? "(none)"} · status=${c.status ?? "(none)"} · product_id=${c.product_id ?? "(none)"}`);
  }

  const angleIds = [...new Set(camps.map((c) => c.angle_id).filter((x): x is string => !!x))];
  if (!angleIds.length) {
    console.log("\nNo angle_id set on any resolved campaign — no product_ad_angles rows to deactivate.");
    return;
  }

  const { data: angles, error: aErr } = await admin
    .from("product_ad_angles")
    .select("id, hook_one_liner, lead_benefit_anchor, meta_headline, meta_primary_text, meta_description, is_active")
    .in("id", angleIds);
  if (aErr) {
    console.error("product_ad_angles read failed:", aErr.message);
    process.exit(1);
  }
  const angleRows = (angles ?? []) as AngleRow[];

  console.log(`\nLF8 scan on ${angleRows.length} referenced angle row(s):`);
  const lf8ThinActive: string[] = [];
  for (const a of angleRows) {
    const copy = [a.hook_one_liner, a.lead_benefit_anchor, a.meta_headline, a.meta_primary_text, a.meta_description]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .join(" \n ")
      .toLowerCase();
    const hit = copy ? hasAnyLf8(copy) : false;
    console.log(`  angle ${a.id} · is_active=${a.is_active} · lf8_hit=${hit}`);
    console.log(`    hook:     ${a.hook_one_liner ?? "(none)"}`);
    console.log(`    anchor:   ${a.lead_benefit_anchor ?? "(none)"}`);
    console.log(`    headline: ${a.meta_headline ?? "(none)"}`);
    console.log(`    primary:  ${a.meta_primary_text ?? "(none)"}`);
    console.log(`    desc:     ${a.meta_description ?? "(none)"}`);
    if (!hit && a.is_active) lf8ThinActive.push(a.id);
  }

  if (!lf8ThinActive.length) {
    console.log("\nNo LF8-thin active angles among the referenced rows — nothing to deactivate.");
    return;
  }

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"}: would deactivate ${lf8ThinActive.length} LF8-thin angle(s) in workspace ${workspaceId}:`);
  for (const id of lf8ThinActive) console.log(`  · ${id}`);

  if (!APPLY) {
    console.log("\nRe-run with --apply to commit the update.");
    return;
  }

  const { error: uErr } = await admin
    .from("product_ad_angles")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .in("id", lf8ThinActive)
    .eq("workspace_id", workspaceId);
  if (uErr) {
    console.error("product_ad_angles update failed:", uErr.message);
    process.exit(1);
  }
  console.log(`\n✓ deactivated ${lf8ThinActive.length} LF8-thin angle(s) — the next Dahlia generate for this product will not reuse them.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
