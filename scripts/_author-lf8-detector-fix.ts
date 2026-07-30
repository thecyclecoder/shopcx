import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "lf8-live-ad-gate-broaden-vocab-and-gate-deactivation-on-performance",
    {
      title:
        "Ads-supervisor LF8 live-ad gate: broaden the keyword vocabulary to cover missing desire clusters, and never auto-deactivate a live angle on a keyword miss alone",
      why: "The ads-supervisor's live-ad LF8 gate is a substring scan over a fixed, coffee/energy-centric keyword list, and it false-flagged four genuinely-strong direct-response ads as LF8-thin in a single 3h pass — enough derivative fix-specs to trip the runaway-authoring breaker. The flagged copy included two weight-loss transformation testimonials and a skin/hair/joints beauty-and-health creamer ad — three of the most powerful Life-Force-8 appeals there are (comfortable living, social approval, superiority, health, beauty). They scored zero only because the vocabulary omits the weight-loss/body-transformation, beauty/appearance, and offer/urgency desire clusters entirely. Worse, the fix ACTION the gate authors deactivates the flagged angle (is_active=false) purely on the keyword miss — with no performance gate — so a false positive can pull a live, spending, converting creative out of Dahlia's rotation. That is the Goodhart degenerate state the north star warns about: an autonomous proxy-optimizer taking a destructive action against the real objective (good creative in market) with no objective-owner check.",
      what: "Make the LF8 live-ad gate both more accurate and non-destructive: (1) broaden the shared LF8 keyword vocabulary to cover the desire clusters it currently misses (weight-loss / body-transformation, beauty / appearance, immunity / digestion, mood / wellness, offer / urgency) so strong benefit-driven copy is no longer false-flagged; (2) change the flag's action so a keyword-thin verdict on its own becomes a copy-enrichment suggestion to Dahlia, and an angle is only ever DEACTIVATED when it is ALSO underperforming on a leading indicator — never on the keyword miss alone.",
      summary:
        "Two-phase growth fix. Phase 1 broadens LF8_KEYWORDS in the shared vocabulary module (used by both the supervisor gate and the creative-brief generator) with the missing desire clusters + a unit test proving the four false-flagged creatives now pass. Phase 2 gates the destructive deactivation in the live-ad LF8 finding on an actual leading-indicator failure (cost-per-ATC over the iteration_policies threshold), demoting a bare keyword-thin flag to a non-destructive Dahlia copy-enrichment suggestion.",
      owner: "growth",
      parent:
        '[[../functions/growth]] — "Static-ad optimization" mandate: the LF8 live-ad QA gate is part of how we keep killer static creative in market and cut losers; a false-positive gate that deactivates strong winning copy actively works against that mandate. See [[../libraries/ads-supervisor]] and [[../libraries/ads-lf8]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Broaden the LF8 keyword vocabulary to cover the missing desire clusters",
          why: "The vocabulary is coffee/energy-centric and omits whole Life-Force-8 desire clusters, so weight-loss transformation copy ('I lost 40+ pounds') and beauty/health copy ('skin, hair, and joints') score zero and get false-flagged as thin.",
          what: "Add the missing desire-cluster terms to the single shared LF8 keyword list and prove the previously false-flagged creatives now register a hit.",
          body: "In src/lib/ads/lf8.ts, extend LF8_KEYWORDS (the single source of truth shared by the ads-supervisor gate at src/lib/ads-supervisor.ts:195 and the creative-brief generator buildMetaCopy) with the desire clusters it currently misses — keep them one-token lowercase for the substring scan, broadly-appealing only:\n  · weight-loss / body-transformation (Life-Force-8 #1/#5/#6/#8): weight, pounds, lbs, lost, slim, lean, shed, appetite, craving, transformation, fit\n  · beauty / appearance (#1/#8): skin, hair, nails, glow, collagen, youthful, radiant\n  · immunity / digestion (#1/#3): immune, immunity, gut, digestion, bloat, gut health\n  · mood / wellness (#1/#3): mood, happy, balance, wellness, thrive\n  · offer / urgency (#5/#6): save, off, free shipping, deal, today\nThese are the clusters the four folded live-ad-lf8 fix-specs (adsets 120252355815780184, 120252360719940184, 120252360719970184, 120252363256660184) tripped on. Add a unit test (src/lib/ads/lf8.test.ts, run via a new package.json script or an existing test runner) asserting hasAnyLf8 returns true for each of: 'i lost 40+ pounds! appetite suppression/craving control', 'i truly believe it is a reason i lost 35 pounds', 'support skin, hair, and joints while you sip. salted caramel creamer with collagen and clean mct', 'flash sale - save up to 43%'. Keep the gate/generator sharing this one list so they cannot drift. Update docs/brain/libraries/ads-lf8.md (or the ads-supervisor page) per CLAUDE.md.",
          verification:
            "- tsc --noEmit clean\n- LF8_KEYWORDS carries the new weight-loss / beauty / offer desire-cluster terms\n- the four previously-false-flagged creatives now register an LF8 hit (unit test)",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "LF8_KEYWORDS gained a weight-loss/body-transformation term",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "pounds\\|weight\\|appetite", path: "src/lib/ads/lf8.ts", expect: "present" },
            },
            {
              position: 3,
              description: "LF8_KEYWORDS gained a beauty/appearance term",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "skin\\|collagen\\|glow", path: "src/lib/ads/lf8.ts", expect: "present" },
            },
            {
              position: 4,
              description: "a unit test covers the previously false-flagged creatives",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "hasAnyLf8", path: "src/lib/ads/lf8.test.ts", expect: "present" },
            },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — Never deactivate a live angle on a keyword miss alone; gate on a leading-indicator failure",
          why: "The current fix action deactivates a flagged angle purely on the keyword miss, with no performance gate — so a false positive can pull a live, spending, converting creative out of rotation. A bounded proxy must not take a destructive action against the real objective without the objective-owner's guardrail.",
          what: "Demote a bare keyword-thin verdict to a non-destructive copy-enrichment suggestion, and only ever set is_active=false on an angle that is ALSO failing a leading indicator (cost-per-ATC over the iteration_policies threshold).",
          body: "In src/lib/ads-supervisor.ts, split the live_ad_lf8_thin finding (makeLiveAdLf8Finding, ~line 459; fired at ~line 195) into two dispositions: (a) keyword-thin but NOT underperforming → author a copy-ENRICHMENT suggestion (a Dahlia regenerate/enrich brief that biases the caption toward an LF8-adjacent benefit — the same buildMetaCopy path the generator already uses), NEVER a deactivation; (b) keyword-thin AND underperforming on the leading indicator → the existing deactivation path is allowed. 'Underperforming' = the adset's cost-per-add-to-cart exceeds the early_trim threshold read from the live iteration_policies row (the same SSOT Bianca's trim logic reads — do NOT hardcode; fall back to the code default only if the column is null), evaluated over the adset's lifetime metrics. Correspondingly, the generated fix-script convention (scripts/fix-live-ad-lf8-*.ts) must not flip is_active=false unless the underperformance gate passed — a keyword miss on a live converting angle is surfaced, not executed. This keeps the gate a supervised proxy: it proposes copy enrichment, and only disposes (deactivates) when the objective metric agrees. Update docs/brain/libraries/ads-supervisor.md per CLAUDE.md (document the two dispositions + the performance gate).",
          verification:
            "- tsc --noEmit clean\n- a keyword-thin-only angle produces a copy-enrichment suggestion, not a deactivation\n- deactivation is gated on the iteration_policies leading-indicator threshold",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "the live-ad LF8 disposition reads the iteration_policies leading-indicator threshold before deactivating",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "iteration_policies\\|early_trim\\|cost.*atc\\|costPerAtc", path: "src/lib/ads-supervisor.ts", expect: "present" },
            },
            {
              position: 3,
              description: "a keyword-thin verdict has a non-destructive enrichment/suggestion path",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "enrich\\|suggest\\|regenerate", path: "src/lib/ads-supervisor.ts", expect: "present" },
            },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#static-ad-optimization" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
