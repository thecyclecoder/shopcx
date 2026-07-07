import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const s = await authorSpecRowStructured(WS, "prompt-auto-review-becomes-box-agent-under-june", {
    title: "Prompt auto-review becomes a supervised box-session agent under June (CS Director), not a headless Opus API cron",
    why: "The sonnet-prompt-auto-review runs as an Inngest cron that makes a raw Anthropic API call (a direct fetch to the messages endpoint, model claude-opus-4-7) to approve or reject proposed conversation rules — the very rules that shape how the AI talks to customers. That is a silent proxy-optimizer: an autonomous decider with real influence over customer-facing behavior, running with no role-agent owning the objective, no reasoning surfaced to a supervisor, and no director grading it. It is the exact north-star inversion the rest of this work fixed elsewhere — a tool optimizing a bounded proxy (approve/reject each proposal) with nobody owning the real objective (conversation-rule quality). CS owns the conversation-rule library (sonnet_prompts + grader_prompts) and June is the CS Director who supervises CS workers, so the prompt auto-reviewer belongs in June's charge as a box-session agent — surfacing its reasoning, recorded to the director's activity log, and graded by the CS director's sweep — not a cron firing blind API calls.",
    what: "Move the prompt auto-review off the raw-API Inngest cron and run it as a box-session agent (a CS-owned agent kind) dispatched on the builder box like the other role agents, supervised by June (the CS Director): each decision surfaces its reasoning, is recorded to director_activity, and falls in the CS director's gradeable charge — while still writing the same auto_decision fields on sonnet_prompts. The headless Anthropic fetch is retired.",
    summary: "**Brain refs:** [[../libraries/sonnet-prompt-auto-review]] [[../functions/cs]] [[../operational-rules]] [[../tables/director_activity]]. Grounded in: src/lib/sonnet-prompt-auto-review.ts (REVIEW_MODEL=OPUS_MODEL; a direct fetch to https://api.anthropic.com/v1/messages at ~:272 with ANTHROPIC_API_KEY) + src/lib/inngest/sonnet-prompt-auto-review.ts (the cron `0 11 * * *`). North-star: CEO → role agent → tool ([[../operational-rules]] § North star). June = CS Director (the cs-director-call agent). CS owns the conversation-rule library per [[../functions/cs]]. Same supervised-autonomy pattern as the box-hosted CS agents (solver→skeptic→quorum triage, cs-director-call).",
    owner: "cs",
    parent: '[[../functions/cs]] — CS owns the conversation-rule library (sonnet_prompts / grader_prompts); its auto-reviewer must be a supervised box-session agent in June (CS Director)\'s charge, not a headless Opus API cron optimizing a proxy with no objective-owner.',
    blocked_by: [],
    phases: [
      {
        title: "Phase 1 — run the auto-review as a box-session agent, not a raw-API cron",
        why: "The decision-making must move onto the box-session agent rails (where role agents run, surface reasoning, and are auditable) so it stops being a headless API call and becomes a supervisable worker.",
        what: "A CS-owned agent kind dispatched + run on the builder box performs the per-proposal review as an agent session (surfacing reasoning), writing the same auto_decision fields on sonnet_prompts; the Inngest cron's direct Anthropic fetch is removed.",
        body: "Introduce a box agent kind (e.g. 'prompt-review') dispatched by the builder worker (scripts/builder-worker.ts, like runCsDirectorCallJob) that reads the proposed sonnet_prompts + the inputs reviewWorkspace assembles and emits a per-proposal verdict as an AGENT session (reasoning surfaced), then the deterministic worker writes status + auto_decision/auto_decision_reason/auto_decision_model/confidence exactly as today. Remove the direct fetch to api.anthropic.com in src/lib/sonnet-prompt-auto-review.ts (and retire or repoint the Inngest cron in src/lib/inngest/sonnet-prompt-auto-review.ts to enqueue the box job instead of calling the API). Preserve the REJECT_FLOOR / never-queue-to-humans behavior. Cite the current fetch + the builder-worker agent-dispatch pattern.",
        verification: "Proposed prompts are decided by a box-session agent run (an agent session exists per review, reasoning captured), not a direct Anthropic fetch from Inngest. The same auto_decision fields are written with equivalent accept/reject outcomes on a replay of recent proposals. No code path in the auto-review calls api.anthropic.com directly.",
        status: "planned",
      },
      {
        title: "Phase 2 — supervise it under June: reasoning surfaced, recorded, graded",
        why: "Being a box agent is only half the fix; it must answer to the CS Director so the objective (conversation-rule quality) has an owner and the proxy-optimizer can be corrected — the north-star requirement.",
        what: "The prompt-review agent's decisions are recorded to director_activity in June's charge and fall in the CS director's gradeable kinds, so the CS director sweep grades them and the reasoning is reviewable; June owns the objective while the agent optimizes the bounded per-proposal proxy.",
        body: "Record each prompt-review verdict to [[../tables/director_activity]] under the CS function so June (CS Director) supervises it, and add the new kind to the CS director's gradeable set (ownerFunctionForKind(kind)==='cs' / gradeableKindsForFunction in the agent-grader) so the director sweep grades it — same discipline as the other CS box agents. Surface the agent's reasoning on the proposed-prompt review view. State the objective ownership: June owns conversation-rule quality; the agent optimizes 'review each proposal well' and escalates on its rails rather than silently. Cite director_activity + the agent-grader gradeable-kinds gate.",
        verification: "Each auto-review decision has a director_activity row in the CS function's scope; the CS director sweep includes the prompt-review kind and grades it; the agent's reasoning is viewable alongside the decision. A decision that hits a guardrail escalates to June rather than executing silently.",
        status: "planned",
      },
    ],
  }, "planned", { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "cs#conversation-rules" });
  console.log("prompt-review-agent spec:", s ? "authored" : "FAILED");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(e);process.exit(1);});
