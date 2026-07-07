/**
 * Author the "guaranteed, observable, self-running ticket handling" GOAL +
 * MILESTONES via the goals-table SDK (never raw .from('goals')). Milestones
 * only — Pia (plan agent) decomposes each into specs after greenlight.
 * Status = proposed (awaiting founder greenlight).
 */
import "./_bootstrap";
import { upsertGoal } from "../src/lib/goals-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods

async function main() {
  const res = await upsertGoal(
    WS,
    {
      slug: "guaranteed-ticket-handling",
      title: "Ticket handling — guaranteed, observable, self-running",
      owner: "cs",
      proposer_function: "ceo",
      status: "proposed",
      why: "Two problems: (1) we tell customers we did things we didn't do — broken_action/false_promise outnumber problem-misreads ~12:1, and it's deterministically fixable; (2) escalations and health-monitoring land on the founder. Meanwhile the problem space has CONVERGED (29 intents, 0 new in July; <10% truly-novel problems), so most 'rare paths' are just the interpreter re-improvising known resolutions. That means we can guarantee actions, make every resolution a structured record, route on difficulty not stakes, compile the routine, and put a CS Director on top that runs the function and reports to the founder in storylines.",
      outcome:
        "Every customer-facing claim is rendered from a VERIFIED action (never free-written); every resolution is a structured record (problem + confidence + a write-ahead action ledger + outcome); control routes on typed state, not tag strings; compiled trees own routine volume with real SDK actions to route to; and an autonomous CS Director makes the hard calls, senses function health, and reports to the founder in storylines.",
      success_metric:
        "broken_action/false_promise grader issues → ~0; execution-failure rate materially down; interpreter (Opus) share of handling down while AI-grade + CSAT hold or rise; per-ticket escalations to the founder replaced by a batched storyline digest.",
      body:
        "Not a rewrite — the 'rethink' half-exists (journeys/playbooks/workflows are already compiled trees). We add a spine (the resolution record = a write-ahead, verified action ledger), move control off tag-strings onto typed state, build the missing high-value commerce actions, grow tree coverage via a record-mining compiler loop, and place a CS Director as the objective-owner on top. Safety leans on the goals system's atomic milestone merge: each milestone lands whole or not at all; every change is additive/flag-gated/fail-safe and shadow-measured before defaults flip; and the ORDER is itself a guardrail — we guarantee actions before anything cheaper or more autonomous is allowed to decide them.",
    },
    [
      {
        position: 1,
        title: "Truthful actions",
        why: "The #1 quality gap: we assert completed effects that no action backs (~12:1 over misreads). Fully deterministic to fix.",
        what: "Every customer-facing effect claim is rendered from a verified action; unverified claims escalate instead of shipping. Verification runs on ALL paths; refunds gain verify-by-id + a durable record.",
        body: "Phase 0 (shipped separately, PR #1232): claim↔action binding guard on the no-action send path. Phase 1: run the verify+escalate block on the inline (journey/playbook-alongside) path; extend verifyActionInDB past its 7 covered types (returns, date/frequency, swap/remove/quantity, price); refund integrity — verify-by-refund-id (never re-fire), an order_refunds mirror, and a T+3d settlement reconcile.",
      },
      {
        position: 2,
        title: "The resolution record (the spine)",
        why: "We throw away the structure of every resolution (options weighed, what worked), so we can't verify, track, or learn — options/accepted are gone on ~91% of tickets.",
        what: "Each ticket carries a structured record: identified problem + confidence, a write-ahead action ledger (proposed → executing → executed → verified), options, and outcome. A ticket = several of these (multi-funnel).",
        body: "Extend the decision schema (problem/confidence/options/chosen — the model already reasons about these, we just persist them). New ticket_resolution_events table = the write-ahead ledger Milestone A verifies against AND the substrate Milestone D mines. Confidence-gated problem lock-in: commit the problem as state; a real confirmation turn only on high-ambiguity × irreversible (~6% of tickets), never always-on (+38% turns for ~0 benefit).",
      },
      {
        position: 3,
        title: "Right-cost routing",
        why: "The pb:/crisis/j:cancel tags that mark a ticket as already-on-a-cheap-tree are exactly what model-picker uses to FORCE Opus — we pay the most for our most deterministic tickets. Routing is by stakes, not difficulty.",
        what: "Model choice reads typed state, not tag strings. LTV alone stops buying Opus (keep crisis/linked-accounts/merged, where the replay proved Opus earns it); on drift from a compiled tree, default Sonnet. Dead actions retired.",
        body: "Config-sized and parallelizable (can start immediately); shadow-measured against real tickets before flipping defaults (harness already exists). Retire skip_next_order (88% failure — dead Appstle endpoint); add handler aliases for the no-handler action-type misses.",
      },
      {
        position: 4,
        title: "Capability + compiler loop",
        why: "For the highest-value trees (e.g. checkout/purchase help) the correct action doesn't exist yet; and the interpreter re-improvises resolutions ~30% of the time for problems it has seen hundreds of times.",
        what: "The SDK can create a paid order/subscription and issue a real refund; the shelf-ware order_tracking workflow is dispatched; the record is mined to auto-draft playbooks, with a matcher that defers when unsure.",
        body: "Build the missing commerce actions (create order/subscription — the reference-ticket dead-end; real commerce/refund.ts; $-bearing replacement). Compiler loop: mine recurring problem×resolution → propose playbooks via the existing proposed-rules flow; audit existing playbooks (escalation rate, low-value options); fail-fast escalation. Guardrail: the matcher must defer ('not sure → interpret'); the model stays sovereign over seams, the stakes tail, and novelty-harvesting.",
      },
      {
        position: 5,
        title: "The autonomous CS Director",
        why: "So hard escalations and function-health monitoring stop reaching the founder — the CX function runs itself and reports up in narrative, freeing the founder for growth.",
        what: "A director agent makes the hard calls on no-quorum, senses function health (AI grade, CSAT, execution-failure rate, new-path discovery) with root-cause, and reports to the founder in batched storylines. Graded on CX quality AND goodwill/margin discipline.",
        body: "Escalation ladder becomes orchestrator → triage quorum (solver/skeptic) → CS Director (hard calls) → founder (storylines only + true black-swan). Storylines: systemic early-warnings ('3 refunds this week, all melted-in-transit → packaging signal') + precedent judgment calls; bidirectional (founder reply steers the leash + policy). Anti-Goodhart: NEVER graded on 'fewest escalations to Dylan' (that degenerates to refund-everyone) — the panel it watches for the system is the panel the CEO watches for it. Same director pattern as Ada/Reva (new-agent + director-grade).",
      },
    ],
  );
  console.log("Authored goal:", res.goal_id);
  console.log("Milestone ids (position → id):", res.milestone_ids);
}
main().catch((e) => { console.error(e); process.exit(1); });
