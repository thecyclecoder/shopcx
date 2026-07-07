/**
 * Author the missing M3 spec Pia's plan pass didn't surface: model-picker routes
 * on typed state, not tags — LTV alone stops buying Opus. Goal-bound to
 * guaranteed-ticket-handling M3 (Right-cost routing). Lands in_review (Vale → Ada).
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const M3_MILESTONE = "081440b3-6631-4727-8dd0-ee61fbe9cf18"; // Right-cost routing

async function main() {
  const ok = await authorSpecRowStructured(
    WS,
    "model-picker-routes-on-state-not-tags-ltv-stops-buying-opus",
    {
      title: "model-picker: route on typed state, not tags — LTV alone stops buying Opus",
      why: "The single biggest near-term cost lever + a live Goodhart bug: model-picker forces Opus on tickets ALREADY on a compiled cheap tree (pb:/crisis/j:cancel tags) and buys Opus for any high-LTV ticket regardless of difficulty. Routing is by stakes, not difficulty. Pia's plan surfaced only the M3 dead-action cleanup; this is the model-picker half of the milestone.",
      what: "Model choice stops keying on tag strings and stakes-proxies: high-LTV alone no longer trips Opus; a ticket already on a compiled tree isn't force-upgraded; on drift the model is chosen by the situation (default Sonnet, Opus reserved for genuine stakes — crisis, linked-accounts, recently-merged); and once the resolution record exists, routing reads typed problem-state instead of tags.",
      summary: "**Brain refs:** [[../libraries/model-picker]] [[../lifecycles/ai-multi-turn]]. Grounded in src/lib/model-picker.ts:28 (COMPLEX_TAG_PREFIXES = crisis, pb:, j:cancel, fraud → force Opus) + :30 LTV_OPUS_THRESHOLD_CENTS=20000, and the 142-ticket blind Sonnet counterfactual replay (78% of Opus tickets downgrade-safe within 1 grade pt; crisis + linked-accounts the genuinely-hard exceptions).",
      owner: "cs",
      parent: '[[../goals/guaranteed-ticket-handling]] — M3 "Right-cost routing" milestone: the model-picker/routing half (Pia proposed only the dead-action cleanup; this covers the state-not-tags + LTV change the goal body names as the biggest dollar win).',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — LTV alone no longer trips Opus",
          why: "A high-LTV customer asking a trivial question (WISMO) gets full Opus reasoning purely for who they are — the replay showed these are overwhelmingly Sonnet-safe.",
          what: "Remove the LTV≥$200 signal as a standalone Opus trigger in pickOrchestratorModel; keep every other signal.",
          body: "In src/lib/model-picker.ts, drop the `ltvCents >= LTV_OPUS_THRESHOLD_CENTS` push (:70-71) from the reasons set so LTV alone no longer selects Opus. Keep turn-count, complex tags, crisis-enrollment, linked-accounts, active-subs≥2, recently-merged. Shadow-measure blended per-ticket cost + grade delta on the existing shadow-replay harness (scripts/_replay-*.ts) over the high-LTV bucket BEFORE flipping the default; gate behind a flag if needed.",
          verification: "Unit test: pickOrchestratorModel returns model='sonnet' for a ticket whose ONLY Opus signal is high LTV. Shadow-replay over the high-LTV bucket shows blended cost drop with mean grade held (no ≥1pt regression). ai_token_usage.purpose no longer emits opus(ltv=$…) as a sole reason.",
          status: "planned",
        },
        {
          title: "Phase 2 — don't force Opus on already-compiled-tree tickets; decide drift by situation",
          why: "pb:/j:cancel tags mark a ticket as already on a compiled cheap tree; using them to force Opus is the Goodhart bug — we pay the most for our most deterministic tickets. On-rails steps are already Haiku; only drift reaches the orchestrator, and drift is mostly Sonnet-safe.",
          what: "Reconcile COMPLEX_TAG_PREFIXES so a compiled-tree tag doesn't reflexively upgrade to Opus; on drift default Sonnet, reserving Opus for genuine stakes.",
          body: "In src/lib/model-picker.ts remove pb:/j:cancel from COMPLEX_TAG_PREFIXES (:28) as automatic Opus triggers; a ticket that drifted off a playbook/journey to the orchestrator is decided by the remaining situational signals, defaulting to Sonnet. Keep crisis-enrollment + linked-accounts + recently-merged as Opus triggers (the replay's genuinely-hard buckets). Reconcile the drift note in src/lib/inngest/unified-ticket-handler.ts:1348 ('Routing to Sonnet') so the stated intent and the actual model agree. Shadow-measure before flipping.",
          verification: "ai_token_usage.purpose audit: pb:/j:cancel drift tickets run orchestrator-decision:sonnet, not opus(tag=…); crisis/linked-accounts tickets still run opus. Shadow-replay over the tag-drift buckets shows cost drop with grade held. The :1348 'Routing to Sonnet' note matches the model actually used.",
          status: "planned",
        },
        {
          title: "Phase 3 — route on typed problem-state (after the record lands)",
          why: "Once ticket_resolution_events carries identified_problem + confidence, the router can key on real difficulty instead of stringly-typed tags — the durable fix that retires tag-routing.",
          what: "model-picker consults the resolution record's problem/confidence to choose the model; tag strings demote to fallback.",
          body: "DEPENDS ON the M2 spine spec `ticket-resolution-events-writeahead-ledger-and-decision-schema-extension` shipping first — it creates the identified_problem + confidence fields this phase reads. Once present, extend pickOrchestratorModel to consult the latest ticket_resolution_events row's problem_confidence + problem_bucket (low confidence / genuinely-hard bucket → Opus; else Sonnet), and demote the tag-string checks to a fallback used only when no record exists. Shadow-measure. Do NOT build this phase until the spine is shipped.",
          verification: "With the record present, pickOrchestratorModel's decision is driven by problem_confidence/bucket (unit test with seeded ticket_resolution_events rows). Tag strings are consulted only when no record exists. Shadow-replay confirms parity-or-better grade at lower blended cost.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", milestoneId: M3_MILESTONE },
  );
  console.log(ok ? "authored (in_review)" : "author write FAILED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
