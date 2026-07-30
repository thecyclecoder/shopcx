/**
 * Task #11 — correct the 2 Dahlia M3 specs the Meta-architecture research invalidated.
 * Their premise (asset_feed_spec bands cold/warm/hot captions so each temperature sees its own
 * caption) is WRONG: asset_feed_spec is A/B multivariate optimization within a placement, so a
 * 3-band pack lets Meta serve the HOT/offer caption to a COLD user — the exact mismatch the M1
 * cold-offer gate prevents. Temperature is a placement decision (one creative = one temperature,
 * routed to the right campaign by Bianca), not a caption band. Fold both; re-author the valid R14
 * competitor-selection as a clean standalone spec. Founder-directed 2026-07-16.
 */
import { loadEnv } from "./_bootstrap"; loadEnv();
import { setSpecStatus, upsertSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const M3="7d794d4a-a605-45a3-a248-dd75894e7777"; // Dahlia goal M3 milestone

async function main(){
  await setSpecStatus(WS,"dahlia-temperature-banded-multi-variant-copy-pack","folded","ceo:dylan");
  console.log("folded: dahlia-temperature-banded-multi-variant-copy-pack");
  await setSpecStatus(WS,"dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection","folded","ceo:dylan");
  console.log("folded: dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection");

  const res = await upsertSpec(WS,{
    slug:"dahlia-deeper-competitor-selection",
    title:"Dahlia: deeper competitor selection (drop hardcoded power, prefer deeply-proven, visible fallback)",
    summary:"**Brain refs:** [[../libraries/creative-sourcing]] (`getProvenCompetitorAngles`) · [[../tables/creative_skeletons]] · [[../functions/growth]]\n\nThe surviving-valid half of the two folded M3 specs (temperature-banded-multi-variant-copy-pack + publisher-asset-feed-spec-upgrade). Those two were folded 2026-07-16: their premise — asset_feed_spec bands cold/warm/hot captions so each temperature sees its own — is invalid (asset_feed_spec is A/B optimization within a placement, so a 3-band pack can serve the hot/offer caption to a cold user). Temperature is a PLACEMENT decision: one creative = one temperature (M1 [[dahlia-audience-temperature-marking-and-cold-offer-gate]]), routed to the right campaign by Bianca ([[bianca-route-ready-creatives-by-dahlia-temperature-tag]]). What survives is R14: imitate-then-innovate is only as strong as the competitor angle it selects, so select DEEPER-proven angles.",
    owner:"growth", parent:"[[../goals/dahlia-imitate-then-innovate-copy-engine]] › M3 — Measurement + polish",
    parent_kind:"milestone", parent_ref:M3, blocked_by:[], priority:null, deferred:false,
    intended_status:"planned", intended_status_set_by:"ceo:dylan", auto_build:true, milestone_id:M3,
    related_spec:"dahlia-publisher-asset-feed-spec-upgrade-and-competitor-selection",
    why:"getProvenCompetitorAngles floors at a hardcoded 30d days_running with no resume_advertising filter (creative-sourcing.ts:73), and it hardcodes acquisitionPower=9 rather than reading the full creative_skeletons signal set — creative_skeletons exposes resume_advertising (a real column) and richer signals that are DB-supported but unused. Imitate-then-innovate borrows a competitor's proven composition; a deeply-proven angle (60d+ AND still running) is a far stronger imitation base than a 30d one that may already have been killed. This is the surviving-valid remnant of the two folded cross-temperature specs.",
    what:"getProvenCompetitorAngles gains preferDeeplyProven (raises minDaysRunning to 60 AND filters resume_advertising=true; empty deeply-proven pool falls back to the 30d/no-resume pool with a VISIBLE usedFallback flag → director_activity, never silent). Separately, drop the hardcoded acquisitionPower=9 and rank on the full creative_skeletons signal set, tiebreaking days_running with the skeleton heat/dormant signal. Dahlia's stockProduct opts in. No temperature/asset_feed_spec work (that model is folded).",
  },[
    {position:1, title:"Phase 1 — preferDeeplyProven option (60d + still-running filter, visible fallback)", status:"planned",
     body:"Raise the imitation bar: prefer competitor angles proven for 60d+ AND still running, but never starve a thin-shelf product — fall back visibly.",
     why:"creative-sourcing.ts:73 floors at a hardcoded 30d with no resume_advertising filter; a 30d angle may already be dead. A deeply-proven (60d + resume_advertising=true) angle is a stronger imitate-then-innovate base. creative_skeletons.resume_advertising is a real column, currently unused.",
     what:"getProvenCompetitorAngles accepts preferDeeplyProven:boolean; when true it sets minDaysRunning=60 AND filters resume_advertising=true. When the deeply-proven pool is EMPTY for a product, fall back to the 30d/no-resume pool and return usedFallback:true, surfaced in a director_activity row (visible, not silent). Dahlia's stockProduct passes preferDeeplyProven. Pin with tests for the deeply-proven path, the empty→fallback path, and the visible-fallback signal.",
     verification:"vitest: getProvenCompetitorAngles with preferDeeplyProven raises the floor to 60d + resume_advertising filter; an empty deeply-proven pool returns usedFallback:true and emits the director_activity row; the default (no opt-in) is unchanged. `npx vitest run` green, `npx tsc --noEmit` clean."},
    {position:2, title:"Phase 2 — drop hardcoded acquisitionPower=9; rank on the full skeleton signal set", status:"planned",
     body:"Stop flattening selection to a constant power; rank competitor angles on the real signals creative_skeletons already carries, with a heat/dormancy tiebreak.",
     why:"A hardcoded acquisitionPower=9 discards the discriminating signal the skeleton table holds, so Dahlia can't tell a strong imitation base from a weak one. The full signal set + a days_running/heat tiebreak picks a genuinely better angle.",
     what:"Replace the hardcoded acquisitionPower=9 in the selection path with a rank over the full creative_skeletons signal set (the proven-composition signals), tiebreaking days_running with the skeleton heat/dormant column. Pin with a test that a deeper-proven, hotter skeleton outranks a shallow one and that the constant is gone.",
     verification:"vitest: selection ranks a 60d/high-heat skeleton above a 30d/low-heat one; a grep guard asserts the hardcoded acquisitionPower=9 constant no longer drives selection. `npx vitest run` green."},
  ]);
  console.log("authored: dahlia-deeper-competitor-selection", res.spec_id);
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1)});
