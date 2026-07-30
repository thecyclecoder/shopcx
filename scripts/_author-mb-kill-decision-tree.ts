import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "media-buyer-kill-on-decision-tree-retire-roas-floor",
    {
      title: "Bianca kills on the crown/kill decision-tree — retire the legacy ROAS-floor kill path",
      why: "Bianca is armed and pausing GOOD converting tests. On 2026-07-13 she paused `MB — Test 01 · skeptic v3` (Amazing Coffee) — $678 spend, 13 ATC, 3 sales, CAC $226 — because its ROAS (0.27) fell under the legacy roas_floor (0.30). By the #26 crown/kill decision-tree that test is a KEEP (it has sales, is under the $1,200 deadline, near the $220 hold band). The decision-tree thresholds (crown_min_purchases, hold_band_max_cpa_cents, max_test_spend_cents, early_trim_min_spend_cents) were written onto iteration_policies but the runtime KILL path still fires on roas_floor + the ROAS 'winner-in-decline' detector. There are NO scaling adsets, so every kill lands on a test — and the ROAS floor kills tests that are still legitimately testing.",
      what: "Retire the ROAS-floor kill trigger from the media-buyer plan and kill/trim strictly on the decision-tree: a test is killed ONLY when (a) spend ≥ max_test_spend_cents (deadline) without reaching the hold band, or (b) early-trim spend ≥ early_trim_min_spend_cents with 0 sales (or the trust-Meta leading signals cost-per-ATC / CPM / clicks-no-ATC, with the converter guard). A test with sales, under the deadline, within/near the hold band is NEVER killed. Kills align 1:1 with the 'dud' tier of src/lib/ads/testing-results-sdk.ts tierForTest so the dashboard and the agent agree.",
      summary: "In src/lib/media-buyer/agent.ts computeMediaBuyerPlan, remove the ROAS-floor loser path (src/lib/ads/winning-creative-detect.ts detectWinners→losers, roas_floor 0.30 / pause_min_spend) as a KILL trigger and route kills through the crown/kill decision-tree (the policy thresholds already read by src/lib/ads/testing-results-sdk.ts tierForTest). Keep the trust-Meta leading-signal trim (src/lib/media-buyer/meta-cpa-signal.ts detectMetaCpaLosers) with its converter guard. Since there are no scaling adsets, roas_floor has no remaining consumer — remove it from the kill code.",
      owner: "growth",
      parent: '[[../functions/growth]] — "Static-ad optimization" mandate: the test→scale loop must KEEP converting tests and only cut true losers; the legacy ROAS floor cuts good tests. Sibling to [[../specs/media-buyer-replenish-per-product-scope]] (both fix the runner against the #26 decision-tree).',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Retire the ROAS-floor kill trigger",
          why: "The ROAS-floor 'winner-in-decline' detector kills tests on ROAS < roas_floor (0.30) regardless of sales / testing window, which pauses converting tests like skeptic v3.",
          what: "Remove roas_floor (and the ROAS detectWinners→losers path) as a KILL trigger in the media-buyer plan; it has no remaining consumer once scaling isn't in play.",
          body: "In src/lib/media-buyer/agent.ts computeMediaBuyerPlan the losers/kill branch (see the losers section around agent.ts:692-773 and the plan.kill assembly) uses the ROAS path from src/lib/ads/winning-creative-detect.ts (detectWinners then the roas_floor / pause_min_spend loser rule). Stop using roas_floor as a kill trigger; delete the now-dead ROAS-loser kill code and the roas_floor read in the kill path (leave scale_up_roas_trigger, used by promote/scale). Update docs/brain/libraries/media-buyer-agent.md + winning-creative-detect.md in the same PR per CLAUDE.md.",
          verification: "New unit test in src/lib/media-buyer/agent.test.ts: an active test adset with ROAS 0.27 (< roas_floor 0.30) but 3 purchases, CAC $226, spend $678 (< max_test_spend) is NOT in plan.kill. `npx tsc --noEmit` clean; `npx tsx --test src/lib/media-buyer/agent.test.ts` passes.",
          status: "planned",
        },
        {
          title: "Phase 2 — Kill/trim strictly on the crown/kill decision-tree (parity with tierForTest)",
          why: "Kills must use the same #26 decision-tree the founder reasons on and the dashboard shows, so the agent and /ad-testing-results never disagree.",
          what: "Route the kill decision through the policy decision-tree thresholds, reusing the exact rule in testing-results-sdk tierForTest so an agent kill == a 'dud'-tier test.",
          body: "Compute kills from the crown/kill decision-tree using the iteration_policies thresholds (crown_max_cpa_cents, crown_min_purchases, hold_band_max_cpa_cents, max_test_spend_cents, early_trim_min_spend_cents). Reuse (or mirror + unit-lock) src/lib/ads/testing-results-sdk.ts tierForTest: kill ⇔ tier 'dud' = spend ≥ max_test_spend_cents without reaching the hold band, OR spend ≥ early_trim_min_spend_cents with 0 sales. Keep src/lib/media-buyer/meta-cpa-signal.ts detectMetaCpaLosers (cost-per-ATC / CPM / clicks-no-ATC) as the EARLY leading-signal trim, with its existing converter guard (never trim an adset converting ≤ crown). A test with sales, under deadline, within/near the hold band is never killed. Update docs/brain/libraries/media-buyer-agent.md in the same PR per CLAUDE.md.",
          verification: "Test: the media-buyer kill set for a snapshot equals the set of active tests at 'dud' tier per testing-results-sdk tierForTest on the same inputs. A read-only probe over the live 6 cohorts yields 0 kills (matches 'no active test currently qualifies'). skeptic v3 (3 sales, CAC $226, $678) is NOT killed. `npx tsc --noEmit` clean; media-buyer tests pass.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#static-ad-optimization" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
