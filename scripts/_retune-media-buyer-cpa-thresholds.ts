/**
 * Re-tune the media buyer's CPA thresholds onto the correct BASIS.
 *
 * ## Why
 *
 * The thresholds are compared against META-REPORTED CPA, but they were set as
 * if Meta CPA were true CAC. Measured over the three months with clean insights
 * coverage, Meta-reported CPA runs ~6.4x blended CAC:
 *
 *   2026-05  Meta CPA $326  blended $48  6.8x
 *   2026-06  Meta CPA $267  blended $45  6.0x
 *   2026-07  Meta CPA $347  blended $54  6.4x
 *
 * So a $220 Meta kill line demands a blended CAC of ~$34 while the business
 * actually runs a healthy ~$54 — the agent killed essentially everything
 * (17 actions in a week, account down to 2 live adsets). It was not
 * malfunctioning; it was enforcing a threshold on the wrong basis.
 *
 * ## The new values
 *
 *   crown      $150 -> $240   (CEO)               ~$37 blended, 5.6x LTV:CAC
 *   hold band  $220 -> $450   ($70 blended x 6.4)  the 3x LTV:CAC ceiling
 *   slow kill  $300 -> $600   MUST stay above the hold band
 *
 * The slow-kill move is not optional. `tierForTest` (src/lib/ads/testing-results-sdk.ts)
 * evaluates the slow-kill rule BEFORE the hold band:
 *
 *   if (spend >= slowKillMinSpend && cac > slowKillMaxCpa) return "dud";   // line 93
 *   if (spend >= maxTestSpend && cac > holdBandMaxCpa)     return "dud";   // line 95
 *
 * so past $600 of spend the slow-kill ceiling IS the effective kill line.
 * Raising the hold band while leaving slow-kill at $300 would change almost
 * nothing. The 1.36x slow-kill:hold ratio is preserved ($600/$450), keeping the
 * documented intent that a promising converter is never touched.
 *
 * ## Why a targeted update rather than authorIterationPolicy
 *
 * `IterationPolicyDraft` carries NONE of the CPA / trust-Meta columns, so
 * authoring a new version would silently reset the entire TRUST-META decision
 * tree to DB defaults. That gap is fixed separately; this script changes only
 * the three thresholds on the live row and leaves every other column untouched.
 *
 * Idempotent — re-running is a no-op once the values match. Writes one
 * `director_activity` row so the change is never silent.
 *
 *   npx tsx scripts/_retune-media-buyer-cpa-thresholds.ts            # dry run
 *   npx tsx scripts/_retune-media-buyer-cpa-thresholds.ts --apply
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";

const APPLY = process.argv.includes("--apply");
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

const TARGET = {
  crown_max_cpa_cents: 24000,      // $240
  hold_band_max_cpa_cents: 45000,  // $450
  slow_kill_max_cpa_cents: 60000,  // $600
} as const;

const RATIONALE =
  "CPA thresholds re-based onto Meta-reported CPA (CEO 2026-08-24). Meta CPA runs ~6.4x " +
  "blended CAC (May-Jul 2026), so the old $150/$220 lines demanded a blended CAC of ~$23/$34 " +
  "while the business runs a healthy ~$54 — the agent killed essentially everything. " +
  "New: crown $240 (~$37 blended, 5.6x LTV:CAC), hold $450 (~$70 blended, the 3x ceiling), " +
  "slow-kill $600 (must stay above the hold band; tierForTest evaluates it first).";

const $ = (c: number) => "$" + (c / 100).toFixed(0);

async function main() {
  const admin = createAdminClient();

  const { data: policy, error } = await admin
    .from("iteration_policies")
    .select("id,version,status,mode,crown_max_cpa_cents,hold_band_max_cpa_cents,slow_kill_max_cpa_cents,trust_meta_reported_signal")
    .eq("workspace_id", WS).eq("status", "active").is("campaign_id", null).maybeSingle();
  if (error) throw new Error(`iteration_policies: ${error.message}`);
  if (!policy) throw new Error("no active null-campaign policy for this workspace");

  console.log(`active policy v${policy.version} (${policy.id})  mode=${policy.mode}  trust_meta=${policy.trust_meta_reported_signal}\n`);
  console.log("threshold                    current      new");
  let changed = false;
  for (const [k, v] of Object.entries(TARGET)) {
    const cur = Number((policy as Record<string, unknown>)[k] ?? 0);
    const mark = cur === v ? "  (already set)" : "  ←";
    if (cur !== v) changed = true;
    console.log(`  ${k.padEnd(26)} ${$(cur).padStart(6)}   ${$(v).padStart(6)}${mark}`);
  }

  if (!policy.trust_meta_reported_signal) {
    console.log("\n⚠ trust_meta_reported_signal is FALSE — these CPA thresholds are not the active");
    console.log("  decision path on this policy. Verify before relying on this change.");
  }
  if (!changed) { console.log("\nAlready at target — nothing to do."); return; }
  if (!APPLY) { console.log("\nDRY RUN — re-run with --apply to write."); return; }

  const { error: upErr } = await admin
    .from("iteration_policies")
    .update({ ...TARGET, updated_at: new Date().toISOString() })
    .eq("id", policy.id)
    .eq("status", "active"); // compare-and-set: never edit a superseded row
  if (upErr) throw new Error(`update failed: ${upErr.message}`);

  const { error: actErr } = await admin.from("director_activity").insert({
    workspace_id: WS,
    director_function: "growth",
    action_kind: "media_buyer_cpa_thresholds_rebased",
    spec_slug: null,
    reason: RATIONALE,
    metadata: {
      policy_id: policy.id,
      policy_version: policy.version,
      before: {
        crown_max_cpa_cents: policy.crown_max_cpa_cents,
        hold_band_max_cpa_cents: policy.hold_band_max_cpa_cents,
        slow_kill_max_cpa_cents: policy.slow_kill_max_cpa_cents,
      },
      after: TARGET,
      meta_cpa_to_blended_ratio: 6.4,
      basis_months: ["2026-05", "2026-06", "2026-07"],
      autonomous: false,
    },
  });
  if (actErr) console.error(`⚠ audit row failed (thresholds DID change): ${actErr.message}`);

  const { data: after } = await admin.from("iteration_policies")
    .select("crown_max_cpa_cents,hold_band_max_cpa_cents,slow_kill_max_cpa_cents")
    .eq("id", policy.id).single();
  console.log(`\nAPPLIED. verified: crown ${$(Number(after?.crown_max_cpa_cents))} · hold ${$(Number(after?.hold_band_max_cpa_cents))} · slow-kill ${$(Number(after?.slow_kill_max_cpa_cents))}`);
  console.log("director_activity: media_buyer_cpa_thresholds_rebased");
}

main().then(() => process.exit(0)).catch((e) => { console.error(errText(e)); process.exit(1); });
