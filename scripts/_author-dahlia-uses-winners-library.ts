import { loadEnv } from "./_bootstrap"; loadEnv();
import { upsertSpec } from "../src/lib/specs-table";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG="dahlia-researches-from-winners-flow-ad-library";
const PARENT='[[../functions/growth]] — "Ad Creative (Dahlia, under Max)" mandate: Dahlia researches competitor WINNERS (proven, scored, concept-tagged creative) from the winners-flow ad library; Max QAs + grades her creative. Platform builds ([[../functions/platform]]).';
(async()=>{
  const res=await upsertSpec(WS,{
    slug:SLUG,
    title:"Dahlia researches from the winners-flow ad library + Max grades her creative in QA",
    summary:"**Brain refs:** [[../integrations/adlibrary]] (two-lane winners flow) · [[../libraries/adlibrary-winners]] · [[../tables/creative_skeletons]] (`winner_tier`/`concept_tags`) · [[../libraries/creative-agent]] (Dahlia) · [[../libraries/ads-supervisor]] / Max's QA-QC session ([[../goals/dahlia-imitate-then-innovate-copy-engine]] M1 `dahlia-max-independent-copy-qc-box-session`). **DEFERRED** — un-defer once (a) the winners-flow collection ships (LANE A winners scan + LANE B domain + our-vision rubric + the ~158-ad backfill) AND (b) the dahlia goal ships. Then: (1) Dahlia's research reads the ENHANCED library — tier-ranked winner concepts + their unified breakdown (angle/archetype/why_it_works/cialdini_lever/awareness_stage); (2) Max, in his QA/QC session, GRADES each Dahlia creative on a fixed rubric — competitor selection · temperature selection · creative quality · scroll-stopping · direct-response/consumer-psychology — using the winner-library breakdown as the benchmark.",
    owner:"growth", parent:PARENT, parent_kind:"mandate", parent_ref:"growth#ad-creative-dahlia-under-max-beside-bianca",
    priority:"medium", deferred:true, intended_status:"planned", intended_status_set_by:"ceo:dylan", auto_build:false, milestone_id:null,
    why:"The ad library is upgrading from recent-keyword skeletons to proven, scored, concept-tagged WINNERS. That upgrade only pays off when (a) Dahlia RESEARCHES from the winner concepts + unified breakdown, and (b) Max SUPERVISES her against the same rubric in QA — grading competitor selection, temperature selection, creative quality, scroll-stopping, and DR/consumer psychology so bad creative is caught before it ships and Dahlia gets a graded signal to improve. Deferred so it builds only after the winners flow + the in-flight dahlia goal ship.",
    what:"When un-deferred: (Phase 1) point Dahlia's creative-brief/angle-selection at the winner concepts (rank by winner_tier/composite, read concept_tags as the imitation rubric); (Phase 2) add the Dahlia-creative grading rubric to Max's QA/QC session — competitor selection · temperature selection · creative quality · scroll-stopping · DR/consumer-psychology — scored per creative and recorded on the grade ledger, lane-agnostic (both AdLibrary-AI and our-vision rows share the breakdown shape).",
  },[
    { position:1, title:"Phase 1 — Dahlia's research reads winner tiers + unified breakdown", status:"planned",
      body:"Point the creative-brief / angle-selection at the winners-flow library: rank candidates by winner_tier/composite, read concept_tags as the imitation rubric, prefer high-confidence winners. Lane-agnostic (AdLibrary AI + our vision share the schema).",
      why:"The enhanced library only pays off once Dahlia actually researches from the winner concepts + their breakdown.",
      what:"Update creative-agent.ts / creative-brief.ts angle/brief construction to consume creative_skeletons.winner_tier + concept_tags; verify a generated brief cites a real winner concept's rubric.",
      verification:"vitest: given seeded winner-tier + concept_tags rows, the brief/angle selection ranks winners first and surfaces the unified breakdown fields; `npx tsc --noEmit` clean." },
    { position:2, title:"Phase 2 — Max grades Dahlia's creative in QA on the fixed rubric", status:"planned",
      body:"In Max's QA/QC session over each Dahlia creative, score a FIXED rubric — competitor selection, temperature selection, creative quality, scroll-stopping, direct-response/consumer-psychology — using the winner-library breakdown as the benchmark, and record it on the grade ledger so Dahlia gets a per-creative graded signal (and a bad one is caught before it ships).",
      why:"Supervisable-autonomy north star: Dahlia optimizes a proxy (bin depth); Max owns the objective (winning creative) and must grade her on the dimensions that actually make a static win — not just count outputs.",
      what:"Add the 5-axis Dahlia-creative rubric to Max's QA/QC pass (the ads-supervisor / dahlia-max-independent-copy-qc-box-session path); each axis scored 1-10 with a reason, persisted to the director/grade ledger; lane-agnostic. Surface the grade on Dahlia's agent profile.",
      verification:"vitest: a QA pass over a fixture creative emits all 5 rubric axes (competitor-selection, temperature-selection, creative-quality, scroll-stopping, dr-psychology) with scores + reasons and writes one grade row; `npx tsc --noEmit` clean." },
  ]);
  console.log("updated (deferred):", res.spec_id, "phases:", JSON.stringify(res.phase_ids));
})().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
