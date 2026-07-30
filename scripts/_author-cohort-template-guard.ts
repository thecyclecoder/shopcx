import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "media-buyer-cohort-adset-template-guard-backfill-and-escalate",
    {
      title: "Media buyer: backfill missing cohort adset_template, guard against null, and escalate an under-provisioned cohort instead of silently deferring",
      why: "Superfood Tabs has been frozen at 2 of 4 active test ads for days and nobody was alerted. Root cause: its active per-test cohort has a null adset_template while all five other products' active cohorts carry a valid template. Bianca's replenish fails closed on every attempt ('per-test cohort missing adset_template — skipped to avoid a malformed ad set') and only writes a quiet media_buyer_replenish_missing_config audit row — so the product sits under-provisioned indefinitely with no escalation. This is a supervisable-autonomy miss: a rail hit (can't provision) must ESCALATE, not silently no-op, and provisioning must never leave an active cohort un-replenishable.",
      what: "Backfill the missing adset_template on any active per-test cohort so Bianca can immediately mint the missing Tabs adsets; guard the provisioning path so an active adset_per_test cohort can never persist with a null template; and turn the replenish missing-config defer on an ACTIVE cohort into a deduped director/CEO escalation instead of only a silent audit row.",
      summary: "Fix the null adset_template on the active Tabs cohort in media_buyer_test_cohorts (via buildAdsetTemplate in provision-cohort.ts), add an invariant + guard so it can't recur, and escalate the media_buyer_replenish_missing_config branch in the media-buyer agent when the cohort is active. Unblocks the Tabs 2/4 stall.",
      owner: "growth",
      parent: '[[../functions/growth]] — "Media buyer (Bianca, under Max)" mandate: Bianca owns filling each product to its test-slot target; a cohort she can\'t replenish is a provisioning rail she must escalate, not silently skip. See [[../libraries/media-buyer-agent]] and [[../libraries/media-buyer-provision-cohort]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Backfill the missing adset_template on active per-test cohorts",
          why: "The active Tabs cohort has adset_template=NULL, so every replenish fails closed and Tabs is frozen at 2/4; setting the template unblocks the next pass immediately.",
          what: "Rebuild and set the adset_template for any active adset_per_test cohort whose template is null/incomplete, using the account's pixel.",
          body: "Add scripts/_backfill-cohort-adset-template.ts (a `_` throwaway) that, via createAdminClient(), selects media_buyer_test_cohorts rows where workspace_id = the Superfoods workspace AND is_active = true AND adset_per_test = true AND (adset_template IS NULL OR adset_template->>'pixelId' IS NULL). For each, build a template with buildAdsetTemplate({ pixelId }) from src/lib/media-buyer/provision-cohort.ts, sourcing pixelId from a SIBLING active cohort on the same meta_ad_account_id (they all share pixel 468487900426092) — do NOT invent one; if no sibling pixel is resolvable, skip that cohort and log it. Update the row's adset_template and log before/after counts. This exactly restores the value provisionProductTestCohort would have written (provision-cohort.ts:92,102). Note the one-time backfill in docs/brain/libraries/media-buyer-provision-cohort.md per CLAUDE.md.",
          verification: "- tsc clean\n- the backfill script exists and uses buildAdsetTemplate",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "backfill script present", kind: "auto", exec_kind: "grep", params: { pattern: "media_buyer_test_cohorts", path: "scripts/_backfill-cohort-adset-template.ts", expect: "present" } },
            { position: 3, description: "backfill rebuilds the template via buildAdsetTemplate", kind: "auto", exec_kind: "grep", params: { pattern: "buildAdsetTemplate", path: "scripts/_backfill-cohort-adset-template.ts", expect: "present" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — Guard: an active per-test cohort can never persist a null adset_template",
          why: "Provisioning already sets the template, but a stale/legacy row slipped through with null and nothing caught it — the invariant must be enforced, not assumed.",
          what: "Assert a non-null template when activating a per-test cohort, and expose a reusable guard the replenish path uses.",
          body: "In src/lib/media-buyer/provision-cohort.ts add an exported guard `assertCohortReplenishable(cohort)` (or `isCohortReplenishable`) that returns false / throws when an adset_per_test cohort has a null test_meta_campaign_id or a null/incomplete adset_template (missing pixelId). Call the assertion in provisionProductTestCohort before the insert so a cohort can never be activated without a template. Reference the guard from the replenish check in agent.ts (Phase 3) so the 'missing config' branch and provisioning share one definition of 'replenishable'. Update docs/brain/libraries/media-buyer-provision-cohort.md per CLAUDE.md.",
          verification: "- tsc clean\n- the replenishable guard is exported from provision-cohort",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "a cohort-replenishable guard is exported", kind: "auto", exec_kind: "grep", params: { pattern: "CohortReplenishable", path: "src/lib/media-buyer/provision-cohort.ts", expect: "present" } },
          ],
          status: "planned",
        },
        {
          title: "Phase 3 — Escalate an under-provisioned active cohort instead of a silent defer",
          why: "A missing-config defer on an ACTIVE cohort left Tabs at 2/4 for days with no signal; a rail hit must escalate to a supervisor, per the north star.",
          what: "When replenish defers on missing config for an active cohort, raise a deduped director/CEO escalation in addition to the audit row.",
          body: "In src/lib/media-buyer/agent.ts, at the media_buyer_replenish_missing_config path (~line 1237) and the per-test-cohort missing template/campaign return (~line 1504), when the cohort is ACTIVE, emit a visible escalation — add a helper `escalateUnderProvisionedCohort({ workspaceId, productId, cohortId, reason })` that writes a dashboard_notifications card (type agent_approval_request or an alert, routed to the growth director / CEO) DEDUPED to at most once per cohort per day (guard on an existing open card for the same cohort+reason so it doesn't spam every 2h pass). Keep the existing director_activity audit row. This makes an un-replenishable product scream instead of silently sitting under target. Update docs/brain/libraries/media-buyer-agent.md per CLAUDE.md.",
          verification: "- tsc clean\n- agent.ts emits an under-provisioned-cohort escalation",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "the escalation helper is wired into the missing-config path", kind: "auto", exec_kind: "grep", params: { pattern: "escalateUnderProvisionedCohort", path: "src/lib/media-buyer/agent.ts", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#media-buyer-bianca-under-max" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
