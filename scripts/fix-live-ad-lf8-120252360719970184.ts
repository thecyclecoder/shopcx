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
 * ── Phase-2 spec-test fix (workspace + product scoping, 2026-07-14) ────────────
 * Pre-merge security-review flagged the earlier iteration: the `.from('ad_publish_jobs')
 * .eq('meta_adset_id', ADSET_ID)` service-role read had no `workspace_id` filter,
 * so a Meta id collision across workspaces (Meta's numeric ids are globally scoped,
 * NOT per-tenant) could have surfaced foreign rows before the later update guard.
 * Fix: pin the run to the exact WORKSPACE_ID + PRODUCT_ID this spec targets
 * (from the spec title + slug prefix + the product id in the spec body), filter every
 * service-role read by them where the table has the column, and hard-assert every
 * resolved row belongs to that (workspace, product) tuple — abort on any mismatch
 * or multi-workspace / multi-product result before logging or mutating.
 *
 * Dry-run by default. Run: `npx tsx scripts/fix-live-ad-lf8-120252360719970184.ts [--apply]`.
 */
import "./_bootstrap";
import { createAdminClient } from "@/lib/supabase/admin";
import { hasAnyLf8 } from "@/lib/ads-supervisor";

/** Pinned scope for this one-off — the fix-spec slug's ws8 prefix is `fdc11e10`
 *  ({@link ads-supervisor.ts fixSpecSlug} = `ads-supervisor-fix-${workspaceId.slice(0,8)}-…`),
 *  which uniquely resolves to this Superfoods workspace. The product id came from the
 *  spec body (Amazing Coffee). Both are HARD BOUNDS — every read below is scoped to them,
 *  and every resolved row is re-checked against them before any log or mutation. */
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const PRODUCT_ID = "ea433e56-0aa4-4b46-9107-feb11f77f533";
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
  workspace_id: string;
  name: string | null;
  angle_id: string | null;
  status: string | null;
  product_id: string | null;
}

interface AngleRow {
  id: string;
  workspace_id: string;
  product_id: string;
  hook_one_liner: string | null;
  lead_benefit_anchor: string | null;
  meta_headline: string | null;
  meta_primary_text: string | null;
  meta_description: string | null;
  is_active: boolean;
}

function abort(reason: string): never {
  console.error(`ABORT: ${reason}`);
  process.exit(1);
}

async function main() {
  const admin = createAdminClient();

  console.log(`Scope pinned to workspace ${WORKSPACE_ID} · product ${PRODUCT_ID} · adset ${ADSET_ID}`);

  // ── 1. ad_publish_jobs — scoped to WORKSPACE_ID + the target adset ───────────
  const { data: pubJobs, error: pubErr } = await admin
    .from("ad_publish_jobs")
    .select("id, workspace_id, campaign_id, meta_adset_id, meta_ad_id, publish_status")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("meta_adset_id", ADSET_ID);
  if (pubErr) abort(`ad_publish_jobs read failed: ${pubErr.message}`);
  const jobs = (pubJobs ?? []) as PubJobRow[];
  if (!jobs.length) {
    console.log(`No ad_publish_jobs found for workspace ${WORKSPACE_ID} with meta_adset_id='${ADSET_ID}' — nothing to fix.`);
    return;
  }
  for (const j of jobs) {
    if (j.workspace_id !== WORKSPACE_ID) abort(`ad_publish_jobs row ${j.id} belongs to workspace ${j.workspace_id}, expected ${WORKSPACE_ID}`);
  }

  console.log(`\nFound ${jobs.length} ad_publish_job(s) for adset ${ADSET_ID}:`);
  for (const j of jobs) {
    console.log(`  job ${j.id} · campaign ${j.campaign_id} · meta_ad ${j.meta_ad_id ?? "(none)"} · status=${j.publish_status ?? "(none)"}`);
  }

  const campaignIds = [...new Set(jobs.map((j) => j.campaign_id).filter(Boolean))];

  // ── 2. ad_campaigns — scoped to WORKSPACE_ID + PRODUCT_ID + the resolved ids ─
  const { data: campaigns, error: cErr } = await admin
    .from("ad_campaigns")
    .select("id, workspace_id, name, angle_id, status, product_id")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("product_id", PRODUCT_ID)
    .in("id", campaignIds);
  if (cErr) abort(`ad_campaigns read failed: ${cErr.message}`);
  const camps = (campaigns ?? []) as CampaignRow[];
  if (camps.length !== campaignIds.length) {
    abort(
      `campaign resolution mismatch — ad_publish_jobs point at ${campaignIds.length} campaign id(s) but only ${camps.length} belong to workspace ${WORKSPACE_ID} + product ${PRODUCT_ID}. Refusing to mutate on a partial resolve (a foreign campaign wired to this adset via a Meta-id collision would silently be skipped, but the FAIL is loud on purpose).`,
    );
  }
  for (const c of camps) {
    if (c.workspace_id !== WORKSPACE_ID) abort(`ad_campaigns row ${c.id} belongs to workspace ${c.workspace_id}, expected ${WORKSPACE_ID}`);
    if (c.product_id !== PRODUCT_ID) abort(`ad_campaigns row ${c.id} belongs to product ${c.product_id ?? "(null)"}, expected ${PRODUCT_ID}`);
  }

  console.log(`\nResolved ${camps.length} ad_campaigns row(s) — all in workspace ${WORKSPACE_ID}, product ${PRODUCT_ID}:`);
  for (const c of camps) {
    console.log(`  campaign ${c.id} · name=${c.name ?? "(none)"} · angle_id=${c.angle_id ?? "(none)"} · status=${c.status ?? "(none)"}`);
  }

  const angleIds = [...new Set(camps.map((c) => c.angle_id).filter((x): x is string => !!x))];
  if (!angleIds.length) {
    console.log("\nNo angle_id set on any resolved campaign — no product_ad_angles rows to deactivate.");
    return;
  }

  // ── 3. product_ad_angles — scoped to WORKSPACE_ID + PRODUCT_ID + the ids ─────
  const { data: angles, error: aErr } = await admin
    .from("product_ad_angles")
    .select("id, workspace_id, product_id, hook_one_liner, lead_benefit_anchor, meta_headline, meta_primary_text, meta_description, is_active")
    .eq("workspace_id", WORKSPACE_ID)
    .eq("product_id", PRODUCT_ID)
    .in("id", angleIds);
  if (aErr) abort(`product_ad_angles read failed: ${aErr.message}`);
  const angleRows = (angles ?? []) as AngleRow[];
  if (angleRows.length !== angleIds.length) {
    abort(
      `angle resolution mismatch — ad_campaigns point at ${angleIds.length} angle id(s) but only ${angleRows.length} belong to workspace ${WORKSPACE_ID} + product ${PRODUCT_ID}. Refusing to mutate on a partial resolve.`,
    );
  }
  for (const a of angleRows) {
    if (a.workspace_id !== WORKSPACE_ID) abort(`product_ad_angles row ${a.id} belongs to workspace ${a.workspace_id}, expected ${WORKSPACE_ID}`);
    if (a.product_id !== PRODUCT_ID) abort(`product_ad_angles row ${a.id} belongs to product ${a.product_id}, expected ${PRODUCT_ID}`);
  }

  console.log(`\nLF8 scan on ${angleRows.length} referenced angle row(s) — all in workspace ${WORKSPACE_ID}, product ${PRODUCT_ID}:`);
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

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"}: would deactivate ${lf8ThinActive.length} LF8-thin angle(s) in workspace ${WORKSPACE_ID}, product ${PRODUCT_ID}:`);
  for (const id of lf8ThinActive) console.log(`  · ${id}`);

  if (!APPLY) {
    console.log("\nRe-run with --apply to commit the update.");
    return;
  }

  // ── 4. Update — compare-and-set on (workspace_id, product_id, id, is_active=true) ─
  // Belt-and-braces: even though we've already validated each row, the update itself
  // re-asserts the scope so a race that flipped a row's ownership between the read and
  // the write would still be caught (the update would touch 0 rows and we'd see it).
  const { data: updated, error: uErr } = await admin
    .from("product_ad_angles")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .in("id", lf8ThinActive)
    .eq("workspace_id", WORKSPACE_ID)
    .eq("product_id", PRODUCT_ID)
    .eq("is_active", true)
    .select("id");
  if (uErr) abort(`product_ad_angles update failed: ${uErr.message}`);
  const updatedIds = ((updated ?? []) as Array<{ id: string }>).map((r) => r.id);
  if (updatedIds.length !== lf8ThinActive.length) {
    console.warn(`⚠ compare-and-set transitioned ${updatedIds.length}/${lf8ThinActive.length} rows — some rows may have been mutated concurrently (still in-workspace so not a security issue; surfaced for audit).`);
  }
  console.log(`\n✓ deactivated ${updatedIds.length} LF8-thin angle(s) — the next Dahlia generate for product ${PRODUCT_ID} will not reuse them.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
