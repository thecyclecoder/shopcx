import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  // Spec A: ticket-analyzer → box agent under June + SDK
  const a = await authorSpecRowStructured(WS, "ticket-analyzer-becomes-box-agent-under-june", {
    title: "The AI ticket analyzer becomes a supervised box-session agent under June, with an SDK for its DB access",
    why: "The ticket quality analyzer runs as a headless job that makes a raw Anthropic API call (a direct fetch to the messages endpoint, a Sonnet grader model) to grade every ticket, decide reopen/escalate, and write ticket_analyses — with no role-agent owning the objective, no reasoning surfaced to a supervisor, and no director grading it. Like the prompt auto-reviewer, it is a silent proxy-optimizer over customer-facing behavior. CS owns the AI quality analyzer + grader rules and June is the CS Director, so the analyzer belongs in June's charge as a box-session agent — surfacing reasoning, recorded to the director's activity log, gradeable by the CS director sweep. It also reads and writes the database directly with raw table calls; that access should go through a typed SDK so the analyzer can never drift from the table's shape and its writes are auditable, the same way PM data goes through the specs SDK.",
    what: "Move the analyzer off the raw-API path and run it as a box-session agent (a CS-owned kind) on the builder box, supervised by June (reasoning surfaced, recorded to director_activity, in the CS director's gradeable charge); and route all of its ticket_analyses reads/writes through a typed analyses SDK instead of raw table calls.",
    summary: "**Brain refs:** [[../libraries/ticket-analyzer]] [[../lifecycles/ai-analysis]] [[../functions/cs]] [[../tables/ticket_analyses]] [[../tables/director_activity]]. Grounded in: src/lib/ticket-analyzer.ts (GRADER_MODEL=SONNET_MODEL; a direct fetch to https://api.anthropic.com/v1/messages ~:576 with ANTHROPIC_API_KEY; applySeverityActions reopen/escalate; raw .from('ticket_analyses'/'tickets') reads+writes) + src/lib/inngest/ticket-analysis-cron.ts. Same supervised-autonomy conversion as [[../specs/prompt-auto-review-becomes-box-agent-under-june]]. June = CS Director (cs-director-call). SDK pattern mirrors the specs-table PM SDK ([[../operational-rules]] § Database is the spec).",
    owner: "cs",
    parent: '[[../functions/cs]] — CS owns the AI quality analyzer + grader rules; the analyzer must be a supervised box-session agent in June (CS Director)\'s charge with a typed SDK for its DB access, not a headless Sonnet API cron writing raw table calls.',
    blocked_by: [],
    phases: [
      {
        title: "Phase 1 — run the analyzer as a box-session agent, not a raw-API cron",
        why: "The grading + reopen/escalate decision must move onto the box-session agent rails so it surfaces reasoning and becomes a supervisable worker instead of a headless API call.",
        what: "A CS-owned box agent kind, dispatched on the builder box, performs the per-ticket grade + severity decision as an agent session (reasoning surfaced) and the deterministic worker applies the same actions + writes ticket_analyses; the direct Anthropic fetch is removed.",
        body: "Introduce a box agent kind (e.g. 'ticket-analyze') dispatched by the builder worker (like runCsDirectorCallJob) that reads the ticket window + guidance + playbook context reviewWorkspace-style, emits the grade + issues + severity verdict as an agent session, then the worker applies applySeverityActions and writes the ticket_analyses row. Remove the direct fetch to api.anthropic.com in src/lib/ticket-analyzer.ts and repoint the cron (src/lib/inngest/ticket-analysis-cron.ts) to enqueue the box job. Preserve all existing gates (do_not_reply skip, ai_disabled / analyzer_locked respect, force-override rules). Cite the current fetch + the builder-worker dispatch pattern.",
        verification: "Tickets are graded by a box-session agent run (agent session + reasoning captured), not a direct Anthropic fetch. A replay of recent tickets yields equivalent scores/severity actions. No analyzer code path calls api.anthropic.com directly. Existing skip/lock gates still hold.",
        status: "planned",
      },
      {
        title: "Phase 2 — supervise it under June + SDK for its DB access",
        why: "It must answer to the CS Director (objective owner) and stop touching the DB with raw table calls; a typed SDK makes its reads/writes auditable and drift-proof, matching how PM data goes through the specs SDK.",
        what: "The analyzer agent's verdicts are recorded to director_activity in June's charge and graded by the CS director sweep; and all ticket_analyses reads/writes go through a typed analyses SDK instead of raw .from() calls.",
        body: "Record each analyze verdict to [[../tables/director_activity]] under the CS function and add the 'ticket-analyze' kind to the CS director's gradeable set (ownerFunctionForKind==='cs' / gradeableKindsForFunction). Add a typed ticket-analyses SDK (getAnalysis/insertAnalysis/listForTicket, mirroring specs-table) and route the analyzer + applySeverityActions writes through it instead of raw .from('ticket_analyses'); optionally add a compliance check (like _check-pm-sdk-compliance) forbidding raw ticket_analyses writes outside the SDK. Cite director_activity + the specs-table SDK pattern.",
        verification: "Each analyze decision has a director_activity row in CS scope; the CS director sweep grades the 'ticket-analyze' kind. All ticket_analyses writes go through the SDK (grep/compliance confirms no raw .from('ticket_analyses').insert/update outside it). The analyzer's reasoning is viewable with the grade.",
        status: "planned",
      },
    ],
  }, "planned", { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "cs#analyzer" });
  console.log("analyzer spec:", a ? "authored" : "FAILED");

  // Spec B: prompt-review SDK follow-up (blocked_by the building prompt-review spec)
  const b = await authorSpecRowStructured(WS, "sonnet-prompts-sdk-for-review-agent-db-access", {
    title: "A typed sonnet_prompts SDK so the prompt-review agent's DB reads/writes go through one auditable layer",
    why: "The prompt auto-review reads proposed rules and writes status + auto_decision fields to sonnet_prompts with raw table calls. As it becomes a supervised box agent, its DB access should go through a typed SDK — the same discipline the PM flow uses (all specs/goals writes go through the specs-table SDK, enforced by a compliance check) — so the reviewer can never drift from the table's shape, its writes are auditable, and no other caller mutates review state ad hoc. Authored as a follow-up because the box-agent conversion spec is already building.",
    what: "A typed sonnet_prompts SDK (read proposed, write decision/status/auto_decision fields, supersede/merge) that the prompt-review agent and any conversation-rule writer use instead of raw table calls, optionally guarded by a compliance check.",
    summary: "**Brain refs:** [[../libraries/sonnet-prompt-auto-review]] [[../tables/sonnet_prompts]] [[../functions/cs]] [[../operational-rules]]. Follows [[../specs/prompt-auto-review-becomes-box-agent-under-june]] (the box-agent conversion — building). SDK pattern mirrors specs-table / the _check-pm-sdk-compliance rail ([[../operational-rules]] § Database is the spec).",
    owner: "cs",
    parent: '[[../functions/cs]] — CS owns the conversation-rule library; writes to sonnet_prompts (review decisions, status, auto_decision) go through one typed SDK, not raw table calls, so review state is auditable and drift-proof.',
    blocked_by: ["prompt-auto-review-becomes-box-agent-under-june"],
    phases: [
      {
        title: "Phase 1 — the sonnet_prompts SDK + route the review agent through it",
        why: "One typed layer for reading proposals and writing decisions makes the reviewer's DB access auditable and prevents shape drift, exactly as the specs SDK does for PM data.",
        what: "A typed SDK for sonnet_prompts (list proposed, apply decision/status + auto_decision fields, supersede/merge) that the prompt-review agent and other conversation-rule writers call instead of raw .from() calls.",
        body: "Add a sonnet-prompts SDK (e.g. listProposed, applyReviewDecision writing status + auto_decision/auto_decision_reason/model/confidence, supersede/merge helpers) mirroring specs-table.ts. Route the prompt-review agent + the daily-analysis/compiler proposal inserts through it instead of raw .from('sonnet_prompts'). Optionally add a compliance check (like scripts/_check-pm-sdk-compliance.ts) forbidding raw sonnet_prompts review-state writes outside the SDK. Cite the current raw writes + the specs-table pattern.",
        verification: "The prompt-review agent reads proposals and writes decisions only through the SDK (grep/compliance confirms no raw .from('sonnet_prompts').update of review/status fields outside it). A decision written via the SDK sets status + all auto_decision fields consistently. Proposal inserts also route through the SDK.",
        status: "planned",
      },
    ],
  }, "planned", { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "cs#conversation-rules" });
  console.log("prompt-review-sdk spec:", b ? "authored" : "FAILED");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
