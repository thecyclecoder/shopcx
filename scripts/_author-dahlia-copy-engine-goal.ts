/**
 * Authors the "Dahlia imitate-then-innovate copy engine" GOAL + its 3 milestones
 * (via the goals-table SDK — never raw .from), greenlights it, and enqueues a
 * kind='plan' agent_jobs row so Pia decomposes it into a spec tree for review.
 * Founder-directed 2026-07-15. Mirrors scripts/_greenlight-and-plan-director-chats.ts.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";
import { upsertGoal, greenlightGoal } from "../src/lib/goals-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "dahlia-imitate-then-innovate-copy-engine";

const BODY = `
Retool Dahlia (Growth's ad-creative agent) from a deterministic caption slot-filler into a real copywriter that IMITATES competitors' proven visual compositions while OUT-WRITING the direct-response psychology competitors overlook. Dahlia is currently PAUSED (kill_switches['ad-creative']) and the unpublished ad bin was wiped, pending this retool.

## Thesis
Competitors have paid 45+ live days to prove which VISUAL compositions stop the scroll; we already borrow them (Nano Banana Pro composition-transfer). The innovation is the layer every DTC brand overlooks: the PSYCHOLOGY of the words + awareness-matching. Keep imitating the proven picture; write the copy in-context on five DR frameworks, tune it to audience temperature, and gate it behind an independent director (Max) who can bounce it back.

## What's broken today (cite the brain + code)
- Copy is deterministic slot-fill (buildMetaCopy, src/lib/ads/creative-brief.ts) — no model authors or revises it, so every ad reads the same flat shape. See docs/brain/libraries/creative-brief.md.
- The only copy-quality gate is keyword presence (hasAnyLf8, src/lib/lf8.ts) — presence, not persuasion. No Schwartz/Cialdini/Hopkins/Sugarman anywhere.
- Zero audience-temperature handling — every creative is implicitly cold yet ships offer/price language to all audiences (the #1 DTC creative error now that Advantage+ makes the creative the audience selector). ad_campaigns has no temperature column (docs/brain/tables/ad_campaigns.md).
- Imitation copies the picture but throws away the competitor's proven WORDS — the de-brand collapses the headline to a generic benefit (creative-agent.ts). creative_skeletons carries {hook, framework, mechanism_claim, proof, offer}; only mechanismClaim is consumed (docs/brain/tables/creative_skeletons.md).
- QC never judges copy — qaCreative checks render booleans on the image only, never the caption (docs/brain/libraries/creative-qa.md).

## Source engine to port
shopgrowth (sibling repo) already built the "Five Frameworks" invisible engine — Life Force 8 (Cashvertising), Schwartz Awareness, Cialdini, Hopkins Specificity, Sugarman Slippery-Slide — plus a 0-10 Conversion-Psychology scoring rubric (5 x 0-2 sub-scores). It lives in shopgrowth/CLAUDE.md and lib/inngest/functions/{generateBrief,generateCopy,generateAngles,analyzeBrief,improveBriefV2}.ts.

## Key design decisions (align, do not re-derive)
- Dahlia = ONE warm box session per creative on Max (flat-rate; same pattern as the shipped qaCreativeViaBoxSession + DAHLIA_QC_MODE kill-switch). The deterministic front half (selectAngles + getProvenCompetitorAngles + buildCreativeBrief) stays and hands the session the brief; the session generates the image (Nano Banana Pro tool, Google-billed), WRITES headline/primary/description in-context, tags temperature, self-scores, revises, and saves ONLY through the validated insertReadyCreative chokepoint.
- Author mode is FLAGGED (DAHLIA_COPY_MODE=author|deterministic), prove-before-default: it becomes default only after beating deterministic on realized CAC/CTR in Bianca's ROAS loop.
- Max (Growth Director) runs an INDEPENDENT QC box session per ad (image+headline+copy) with a red-team lens (not a mirror of Dahlia's rubric). Verdict splits: binary HARD GATES (fabrication, cold-ad-with-offer, competitor-brand leak, >1 promise, render checks) block+bounce to revise; an advisory 0-10 persuasion score is recorded (not a hard block above a low floor) so the rubric can't become a Goodhart objective — correlate it against real CAC.
- Cost rail: a copy-only fail re-writes with NO image regen; only a render fail triggers a paid Nano Banana Pro regen; retry-cap exhaustion escalates (never loops).

## Rails (non-negotiable, carry into every spec)
De-brand every competitor mark · no bare MSRP in the caption · trace every specific claim to product intelligence · never fabricate (three-layer firewall).

## Milestones
M1 (P0 keystone): the copy author session + shared 0-10 rubric + audience_temperature marking/gate + Max independent QC. Ship together behind flags.
M2 (P1 innovation): Five Frameworks skill + never-fabricate firewall + preserve competitor copy DNA de-branded + shared deterministic validator + scroll-stop QC dims + market-sophistication escalation.
M3 (P1/P2 measurement+polish): cold-graded inline-link-CTR leading signal + Andromeda concept-diversity tags + temperature-banded multi-variant pack + publisher asset_feed_spec upgrade + better competitor selection.
`.trim();

async function main() {
  const res = await upsertGoal(
    WS,
    {
      slug: SLUG,
      title: "Dahlia Imitate-Then-Innovate Copy Engine",
      owner: "growth",
      proposer_function: "growth",
      status: "proposed",
      outcome:
        "Dahlia writes killer, awareness-matched Meta ad copy (headline/primary/description) in a single per-creative box session — imitating competitors' proven visual compositions while out-writing the DR psychology they overlook (Five Frameworks + Cold/Warm/Hot temperature) — with every ad independently QC'd by Max and bounced back to revise on a fail.",
      why:
        "Today's copy is deterministic slot-fill gated only by an LF8 keyword scan, so every ad reads flat; competitors overlook DR psychology + awareness-matching, which is exactly the innovation edge. Copy quality is a top CAC/AOV lever and Dahlia is paused pending this retool.",
      success_metric:
        "author-mode creatives beat deterministic slot-fill on realized cold-audience CAC/CTR in Bianca's ROAS loop (promoted to default only on a measured win); zero cold-audience offer-language mismatches; Max's independent QC produces a non-trivial bounce rate (proving he isn't a rubric mirror).",
      body: BODY,
    },
    [
      { position: 1, title: "M1 — Copy keystone (author session + rubric + temperature + Max QC)",
        why: "Make Dahlia actually WRITE copy, tuned to audience temperature, graded by an independent director — the core that everything else builds on.",
        what: "In-context copy author box session (DAHLIA_COPY_MODE=author|deterministic, fails closed to slot-fill); the 0-10 Conversion-Psychology rubric as the shared Dahlia/Max contract (self-score = revise trigger, Max score = binding floor, two sub-scores anchored to deterministic checks); audience_temperature column + Dahlia selects/justifies Cold/Warm/Hot + cold offer-language fail-closed save-gate; Max independent QC box session (hard-gates vs advisory-score split, red-team lens, copy-fail = no image regen, retry-cap → escalate, node-completeness trio). Ship together behind flags, prove-before-default vs deterministic in Bianca's ROAS loop.",
        body: "P0 keystone. Covers workflow items R1 (copy author session), R2 (shared 0-10 rubric), R3 (audience_temperature marking + cold offer-gate), R4 (Max independent QC + revise loop). Ground against docs/brain/libraries/creative-brief.md, creative-qa.md, functions/growth.md, tables/ad_campaigns.md." },
      { position: 2, title: "M2 — Innovation layer (Five Frameworks + firewall + competitor copy DNA)",
        why: "The advanced psychology competitors overlook — the actual 'innovate' half of imitate-then-innovate.",
        what: "Five Frameworks skill doc applied invisibly (LF8/Schwartz/Cialdini/Hopkins/Sugarman) + single-LF8-drive rail; three-layer never-fabricate firewall + typed intelligence-gap to founder + machine-check; preserve the competitor's proven COPY DNA de-branded (abstract the hook template, rewrite on our verified intelligence, >6-consecutive-token originality guard, graceful null-field fallback); one shared deterministic copy validator used by both author + QC (Tier-A hard gate / Tier-B soft signals, em-dash attribution exempt); three binary scroll-stop QC dims (single focal subject, unbranded hook zone, cold-native styling) + image-prompt directives; market-sophistication escalation (stage 1-5 derived from competitor-claim saturation in creative_skeletons; stage 4-5 requires a named mechanism or identity hook).",
        body: "P1. Covers R5, R7, R6, R8, R10, R11. Ground against shopgrowth's Five Frameworks (shopgrowth/CLAUDE.md), docs/brain/tables/creative_skeletons.md, libraries/product-intelligence.md." },
      { position: 3, title: "M3 — Measurement + polish (leading signal, diversity, variant pack, selection)",
        why: "Close the Goodhart loop against real Meta ground truth and sustain creative diversity + smarter imitation.",
        what: "Cold-graded inline-link-CTR leading signal in the ledger (Growth measurement lane — the static analog of hook-rate, benchmarked per placement, cold-only; floor-breach → refresh flag, top-decile → feed winning hook back to the imitate library); Andromeda concept-distinctness via a (hook_type, emotional_register, composition, angle) tag grid + emotional-register enum with a countable ≤40%-per-register cap + Max dedup check; temperature-banded multi-variant copy pack + Meta publisher asset_feed_spec upgrade + variant-set schema (ship together or cut); better competitor selection — drop hardcoded acquisitionPower=9, hand Dahlia the full skeleton signal set, tiebreak days_running with the dormant heat column.",
        body: "P1/P2. Covers R9, R12, R13, R14. R9 is a Growth measurement-lane change (media-buyer/insights SDK + ledger), not Dahlia's copy engine — Pia may route it accordingly." },
    ],
  );
  console.log("goal upserted:", res.goal_id, "milestones:", JSON.stringify(res.milestone_ids));

  await greenlightGoal(WS, SLUG, "ceo:dylan");
  console.log("greenlit:", SLUG);

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("agent_jobs")
    .insert({ workspace_id: WS, spec_slug: SLUG, kind: "plan", status: "queued", instructions: null, created_by: null })
    .select("id")
    .single();
  if (error) throw error;
  console.log("plan job enqueued for Pia:", data.id);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
