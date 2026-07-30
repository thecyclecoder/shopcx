import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main() {
  const ok = await authorSpecRowStructured(
    WS,
    "ready-to-test-exclude-archived-url-removed-creatives",
    {
      title: "Bin readiness count: exclude archived (URL-removed) creatives from listReadyToTest",
      why: "`listReadyToTest` (src/lib/ads/ready-to-test.ts) never filters on `ad_campaigns.status`, so a campaign that was RETIRED by archiving it (status='archived' — how removing an ad's URL is recorded) is STILL counted as ready-to-test as long as it keeps a ready ad_video + a landing_url + no active publish job. Live probe (2026-07-13): of 31 'ready' campaigns the reader returns, ~15 are archived — Creatine Prime, Ashwavana Guru Focus, and Ashwavana Zen Relax each read as a FULL bin (4/4) while having ZERO genuinely-ready creatives. This misreads three ways: (1) /director-training reports full bins that are empty; (2) Dahlia's deficit (src/lib/inngest/ad-creative-cadence.ts `depthByProduct` → `binFloor - depth`) computes deficit=0 and generates nothing, so empty bins never refill; (3) the media-buyer replenish creative-picker (src/lib/media-buyer/agent.ts `listReadyToTest`) could republish a retired creative. All three read the SAME SDK, so one filter fixes all three.",
      what: "listReadyToTest excludes archived/retired campaigns so bin depth reflects only genuinely-launchable creatives — Dahlia refills the truly-empty bins, director-training reports true depth, and replenish never picks a retired creative.",
      summary: "Add `status` to the ad_campaigns select in listReadyToTest and drop campaigns whose status is 'archived' (the retire/URL-removed state; live statuses are ready|archived|draft). Pin it with a ready-to-test.test.ts case and document the 'archived' status in docs/brain/tables/ad_campaigns.md.",
      owner: "growth",
      parent: '[[../functions/growth]] — "Ad creative (Dahlia, under Max — beside Bianca)" mandate: keeping Dahlia\'s ready-to-test bin stocked depends on the bin depth being TRUE; counting retired creatives makes her think empty bins are full. See [[../libraries/ready-to-test]] · [[../tables/ad_campaigns]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Exclude archived campaigns from the ready-to-test reader",
          why: "The single shared reader miscounts retired creatives as ready; excluding archived fixes Dahlia's deficit, director-training, and replenish at once.",
          what: "Filter archived (URL-removed/retired) campaigns out of listReadyToTest and pin it with a unit test.",
          body: "In src/lib/ads/ready-to-test.ts: add `status` to the ad_campaigns SELECT (line ~116) and exclude retired campaigns — `.neq('status','archived')` in the query AND a belt-and-suspenders `if (c.status === 'archived') continue;` in the row loop (mirror the existing `if (!c.landing_url) continue;` guard). Keep the isReadyCreative OR-logic for ad_videos untouched — this only drops the campaign-level retire state. Add a case to src/lib/ads/ready-to-test.test.ts: an archived campaign with a ready ad_video + landing_url + no active publish job must NOT appear in readyToTest (npm run test:ready-to-test). Document the live `archived` value in the docs/brain/tables/ad_campaigns.md status enum (probe shows ready|archived|draft; the page currently lists draft|rendering|ready|failed) + note the reader excludes it, in the same PR per CLAUDE.md.",
          verification: "- tsc clean\n- npm run test:ready-to-test passes with a new archived-exclusion case\n- listReadyToTest filters status='archived' (query + row-loop guard)",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "ready-to-test unit tests green (incl. archived-exclusion case)", kind: "auto", exec_kind: "unit_test", params: { script: "test:ready-to-test" } },
            { position: 3, description: "the reader excludes archived campaigns", kind: "auto", exec_kind: "grep", params: { pattern: "archived", path: "src/lib/ads/ready-to-test.ts", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#ad-creative-dahlia-under-max-beside-bianca" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
