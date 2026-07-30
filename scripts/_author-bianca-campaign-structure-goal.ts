/**
 * Authors the "Bianca temperature-aware campaign structure" GOAL + 4 milestones
 * (goals-table SDK), greenlights it, and enqueues a kind='plan' agent_jobs row so Pia
 * decomposes it. Distinct from the Dahlia copy goal (which owns the temperature column,
 * concept-diversity guard, Max's temperature check). From the meta-campaign-architecture
 * research pass (wf_62cc4fd8). Founder-directed 2026-07-15.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { upsertGoal, greenlightGoal } from "../src/lib/goals-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "bianca-temperature-aware-campaign-structure";

const BODY = `
Give Bianca (Growth's media-buyer) the thin, temperature-aware Meta account structure our loop is missing — routed by Dahlia's temperature tag. Distinct from the Dahlia copy-engine goal (which owns the audience_temperature column, concept-diversity guard, and Max's temperature check).

## Verdict from the research (confidence-labeled)
- Meta POOLS + SELF-SORTS cold traffic by the ad's own creative signal [R-high] — "creative IS the targeting" (Andromeda retrieval). So KILL heavy audience segmentation (lookalikes, interest tiers, warm/cold matrices). Our seasoned pixel + fresh campaigns is the best case for minimal structure.
- Three things Meta will NOT do — the surviving obligations: (1) route by "temperature" (that's OUR construct — it shapes the pixel signal AND decides which campaign we place the ad in); (2) separate new-vs-existing buyers (a pooled campaign drifts to warmest existing buyers, inflates ROAS, little new-customer growth); (3) protect signal hygiene (savings-led cold ads train the pixel toward discount-hunters [R-high]).
- CORRECTION: existing-buyer contamination DEFLATES cost-per-ATC (existing buyers convert cheaper) → the harm is FALSE CROWNS (weak creative promoted to concentrated scale budget), NOT false kills. And that harm bites at a SCALING STAGE OUR CODE DOESN'T HAVE YET — so the exclusion fix and the scaler are coupled.

## Recommended architecture — 3 thin surfaces, routed by temperature
SURFACE 1 TEST (our current lab + fixes): per-product ABO, 4×$150 single-creative adsets, judged on cost-per-ATC. Fix the audience default + add a recent-purchaser exclusion. Perpetual feeder — never pause.
SURFACE 2 COLD-SCALE (the real gap): ONE consolidated Advantage+/CBO with native "Acquire New Customers Only"; crowned winners graduate off the $600 lab ceiling here. Cold creative only, no savings. Optimize for purchase VALUE. Must ship bounded + supervised (own ceiling + own arming + a Max-gradable metric).
SURFACE 3 HOT-RETARGET: DEFERRED out of this goal — one account-level DPA/offer lane, only after Dahlia's Hot lane exists AND an incrementality measurement vs Advantage+'s built-in retargeting. Control on CTR-decay/CPA-rise, not frequency.
SKIP entirely: lookalikes, interest tiers, warm/cold adset matrices, hashed-list exclusion chains.

## Current-loop gaps (verified against src/lib/media-buyer/ + src/lib/ads/)
- Cold test: DEFAULT_TEST_TARGETING = US 18-65, no gender, advantage_audience:1, NO exclusion → re-feeds prior buyers, confounds per-creative attribution, diverges from the documented F50-65 converter.
- Cold scale: NO scaler exists — PROMOTE just raises the $150 test adset in place, hard-capped by the $600/day cohort ceiling. Crowned winners can never concentrate budget (the anti-pattern our own methodology warns against).
- Hot retarget: zero warm/hot audiences, no DPA, no custom audiences/exclusions.
- Temperature routing: insertReadyCreative hard-codes urgency_lever='none'; no temperature column; replenish is a blind readyToTest.slice(0,deficit).
- Scale-edit rails: scale_up ignores per_object_cooldown_hours + per_account_daily_budget_delta_ceiling_cents (both calibrated, both read by decision-engine.ts).

## Guardrails (north-star: supervisable autonomy)
The cold scaler is the highest-risk build (largest autonomous spend surface). It MUST ship with its own daily ceiling column + its own shadow→armed arming authorization (human-vetoable), and it MUST NOT blind Max — keep graduated spend ABO-grained so per-creative ROAS/grader still fire, OR build a campaign-level CAC:LTV sensor BEFORE arming. A scaler Max can't grade is the one thing this must not create.

## Unmeasured numbers that gate builds (verify-scale-numbers rule)
- "40-50% prospecting-budget leak" → gates M2 priority. Measure actual purchaser overlap first; proceed strongly if >~15%.
- "~1,000 weekly cart-abandoner pool" → gates any retargeting. Measure our actual pool first.
Both are estimates until measured — do NOT ship on them.

## Sequencing
M1 + M2 are Bianca-side and INDEPENDENT of Dahlia — they pay off NOW during the creative freeze. M3 is gated on Dahlia shipping the temperature column; M4 is gated on Dahlia supplying a steady crowned-winner stream (you can't seed a scaler with a paused creative engine). Suggested: M1 now → M2 (after measurement) → Dahlia column → M3 → M4.
`.trim();

async function main() {
  const res = await upsertGoal(
    WS,
    {
      slug: SLUG,
      title: "Bianca Temperature-Aware Campaign Structure",
      owner: "growth",
      proposer_function: "growth",
      status: "proposed",
      outcome:
        "A lean 3-surface Meta structure — clean cold test → bounded new-customer cold scaler → (deferred) hot retarget — routed by Dahlia's temperature tag, where crowned winners graduate off the $600 test ceiling into a supervised scaler and existing-buyer contamination is excluded from the cold read. No ungradable autonomous spend surface.",
      why:
        "Meta self-sorts cold traffic by creative signal (kill audience segmentation), but it won't separate new-vs-existing buyers or supply a scaler. Our loop today has only per-product test cohorts — no scaler, no purchaser exclusion, no temperature routing — so crowned winners can never concentrate budget and existing buyers deflate the cold read into false crowns.",
      success_metric:
        "crowned winners graduate off the $600 test ceiling into a new-customer-only cold scaler carrying its own daily ceiling + shadow→armed arming + a Max-gradable metric; the cold test excludes recent pixel-purchasers and aligns to the proven converter (US women 50-65); every surface's spend stays supervised.",
      body: BODY,
    },
    [
      { position: 1, title: "M1 — Clean cold-read (do now, while Dahlia is paused)",
        why: "The cold test is our source of truth for who wins; today it re-feeds prior buyers, confounds per-creative attribution, and its scale-edits ignore calibrated cooldown/ceiling rails. Bianca-side, independent of Dahlia — pays off immediately.",
        what: "(a) Fix DEFAULT_TEST_TARGETING → US age 50-65, genders:[2], REMOVE advantage_audience from the TEST default (keep it as the scaling default); re-backfill the 6 cohorts' adset_template via replenish into NEW adsets (never edit a running adset mid-learning); unit-test-pinned. (b) Port scale-edit cooldown rails into the promote loop before emitting scale_up: skip if the adset had an iteration_actions action within per_object_cooldown_hours; accumulate per-account delta and stop at per_account_daily_budget_delta_ceiling_cents; clamp to per_test_daily_budget_cents. Mirror decision-engine.ts. CUT: the +20% cap (already exists via scale_up_step_pct/cap_pct) and any 'one-edit-per-learning-window' folklore.",
        body: "Effort S+S. Grounded in docs/brain/libraries/media-buyer-agent.md, tables/media_buyer_test_cohorts.md, iteration_policies.md, decision-engine." },
      { position: 2, title: "M2 — Purchaser hygiene (gated on a 1-hour measurement)",
        why: "Existing-buyer contamination deflates cost-per-ATC → false crowns on weak creative that then burn scale budget. The exclusion is coupled to the scaler.",
        what: "FIRST measure actual purchaser overlap in the current test pool; proceed strongly if >~15% (the '40-50% leak' is unmeasured — don't ship on it). v1: (a) create a pixel-based 30-60d PURCHASE custom audience per ad account (Meta-native, NO PII upload — leverages the seasoned pixel); (b) add excluded_custom_audiences to buildAdsetTemplate so all 6 cohorts inherit it in one edit. Defer hashed-list upload + active-subscriber-only per-SKU exclusion to a follow-up.",
        body: "Effort S-M. Corrected rationale: contamination → false crowns, not false kills." },
      { position: 3, title: "M3 — Bianca temperature link (gated on Dahlia's temperature column)",
        why: "Dahlia marks temperature; Bianca must route it. Without an intake filter, warm/hot creatives could enter the cold test and pollute the pixel.",
        what: "COLD-only intake filter: thread the temperature angle → ad_campaigns → ReadyToTestRow and exclude non-COLD creatives from the cold-test readyToTest before the deficit slice. CUT the full 3-way router — defer until M4/retargeting exist, with its own evidence. Blocked on the Dahlia goal's audience_temperature column.",
        body: "Effort S. Depends on dahlia-audience-temperature-marking-and-cold-offer-gate." },
      { position: 4, title: "M4 — Bounded, supervised cold scaler (gated on Dahlia winner supply)",
        why: "Crowned winners are trapped under the $600 test ceiling with no path to concentrate budget — the core growth gap. But the scaler is the largest autonomous spend surface, so it must be bounded + gradable or it violates supervisable-autonomy.",
        what: "getOrCreateScalingCampaign + a graduation primitive: ONE Advantage+/CBO scaler with native 'Acquire New Customers Only' + media_buyer_test_cohorts.scale_meta_campaign_id. MUST ship with its own scale_daily_ceiling_cents AND its own media_buyer_arming_authorization (shadow→armed, human-vetoable); AND either ABO-grained graduated spend OR a campaign-level CAC:LTV sensor BEFORE arming (graduating spend Max cannot grade is the one thing this must not do). Optimize for purchase VALUE. Pick ONE budget model (pooled ASC arbitration OR per-creative ABO) up front. Gated behind the Dahlia rebuild delivering a steady crowned-winner supply.",
        body: "Effort L. Highest-risk build — last + rail-gated. Depends on the Dahlia copy-engine goal." },
    ],
  );
  console.log("goal upserted:", res.goal_id, "milestones:", JSON.stringify(res.milestone_ids));

  await greenlightGoal(WS, SLUG, "ceo:dylan");
  console.log("greenlit:", SLUG);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({ workspace_id: WS, spec_slug: SLUG, kind: "plan", status: "queued", instructions: null, created_by: null })
    .select("id").single();
  if (error) throw error;
  console.log("plan job enqueued for Pia:", data.id);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
