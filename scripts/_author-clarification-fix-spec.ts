/**
 * Fix the context-stripped clarification channel (ticket 71538c70). Julie asked
 * to swap creamer→coffee; Opus reasoned perfectly (order shipped yesterday →
 * can't swap that one; can swap the active sub for the Aug 2 renewal; history
 * shows Cocoa + Hazelnut → ask which) — but all of that lived in the internal
 * `reasoning` field, and the customer got only the bare `clarification_question`
 * string "Which coffee flavor (Cocoa or Hazelnut) and what quantity?" because
 * the executor's clarification branch sends only that field and returns. Option
 * B: fold clarification into the normal full-message path — needs_clarification
 * becomes a turn-state flag, never a separate terse output. cs-owned. in_review.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const s = await authorSpecRowStructured(
    WS,
    "clarification-turns-send-full-message-not-bare-question",
    {
      title: "A clarification turn sends the model's full message, not a context-stripped bare question",
      why: "On ticket 71538c70 the orchestrator reasoned exactly right — the customer's order shipped yesterday so that order can't be swapped, but the active subscription can be swapped for the next renewal, and her history shows both Cocoa and Hazelnut so it should ask which — and then sent the customer only 'Which coffee flavor (Cocoa or Hazelnut) and what quantity?'. All the understanding lived in the internal reasoning field, which never reaches the customer; the executor's clarification branch sends ONLY the separate clarification_question field and returns, and there is zero prompt guidance on how to write a clarification, so the field name induces a bare question. The analyzer correctly flagged it (robotic, missed_opportunity, score 6, escalated). This is the same lossy-emission failure as the agent-context half-mode: the model understands, but the output channel strips the substance. The customer should have gotten 'Your order shipped yesterday so I can't change that one, but I can update your subscription so your next delivery has the swap — would you like Cocoa or Hazelnut?'.",
      what: "Eliminate the bare-question clarification channel: the orchestrator always writes a complete customer-facing message, and when it needs more information that message acknowledges the request, states what can and can't be done, sets expectations, and then asks the question. needs_clarification becomes a turn-state flag (mark the turn as awaiting a reply, still skip actions) rather than a separate terse output; the executor sends the full response, never a bare clarification_question.",
      summary: "**Brain refs:** [[../libraries/sonnet-orchestrator-v2]] [[../libraries/action-executor]] [[../customer-voice]] [[../lifecycles/ai-multi-turn]]. **Derived-from-ticket:** 71538c70 (Julie — creamer→coffee swap; Opus reasoned shipped-order + Aug 2 renewal + Cocoa/Hazelnut, emitted a bare two-word question). Grounded in: src/lib/action-executor.ts (the clarification branch ~:1979 — `if (needs_clarification && clarification_question) { send(clarification_question); return }`), src/lib/sonnet-orchestrator-v2.ts (the decision schema's needs_clarification / clarification_question fields ~:63 with NO prompt guidance on writing them; the reasoning field is internal-only). Same class as [[../specs/human-directives-hard-gates-over-ticket-ai]]'s AGENT-CONTEXT half-mode removal.",
      owner: "cs",
      parent: '[[../functions/cs]] — "Fix weird tickets fast, calibrate so they don\'t recur" mandate: the AI never emits a context-stripped response when it already reasoned the full answer — a clarification turn is a complete message, not a bare question.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — the executor sends the full response on a clarification turn; kill the bare-question branch",
          why: "The structural strip is the executor branch that sends only clarification_question and returns; routing a clarification turn through the normal full-message send removes the terse channel entirely so the model's understanding can reach the customer.",
          what: "On a clarification turn the executor sends the model's full customer-facing response (still skipping actions and marking the turn awaiting a reply), instead of the bare clarification_question string; needs_clarification is retained only as a turn-state flag.",
          body: "In src/lib/action-executor.ts, change the clarification branch (~:1979) so it no longer does send(decision.clarification_question); return. Instead, a clarification turn sends the model's full response message (the same customer-facing field a normal reply uses) and still returns early WITHOUT executing actions (a clarification turn must not act — it's awaiting the answer) and still records needs_clarification for turn-tracking (the clarification-turn counters / journey nudges / no-auto-close behavior). Keep clarification_question only if useful as internal metadata; it is never the thing sent. Cite the clarification branch + the normal response send.",
          verification: "A clarification turn sends the model's full response message (acknowledgment + what can/can't be done + the question), NOT a bare question; no code path sends decision.clarification_question as the whole customer message. Actions are still NOT executed on a clarification turn, and the turn is still marked awaiting-reply (counters/nudges unchanged). A normal (non-clarification) reply is unaffected.",
          status: "planned",
        },
        {
          title: "Phase 2 — prompt the model to write a contextualized clarification (acknowledge → can/can't → expectations → question)",
          why: "Removing the strip only helps if the model fills the full response well; today there is no guidance on writing a clarification, so it defaults to a bare question. Explicit guidance plus a worked example makes the full message land in the customer's voice.",
          what: "Orchestrator prompt guidance that, when more information is needed, the reply must still acknowledge the request, state what can and can't be done and why, set expectations (e.g. the shipped order can't change but the next renewal can), and then ask the specific question — with the coffee-swap ticket as the canonical few-shot.",
          body: "In src/lib/sonnet-orchestrator-v2.ts, add guidance to the prompt: a turn that needs clarification is still a COMPLETE message under the customer-voice rules ([[../customer-voice]]) — acknowledge the request, state what you can and cannot do and why (cite the relevant policy briefly), set expectations, THEN ask the one question you need. Include a worked example from ticket 71538c70: input 'swap creamer for coffee' on a just-shipped order with an active sub → 'Your order shipped yesterday so I can't change that one, but I can update your subscription so your next delivery (Aug 2) has the swap — would you like Cocoa or Hazelnut?'. Keep it within the 2-sentences-per-paragraph, plain-text rules. Cite the prompt + customer-voice.",
          verification: "Replaying ticket 71538c70 through the updated prompt produces a message that (a) acknowledges the swap request, (b) states the shipped order can't be changed but the next renewal can, and (c) asks Cocoa vs Hazelnut — not a bare question. A clarification reply obeys the customer-voice formatting rules. A turn that genuinely needs nothing still answers directly (no forced question).",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "cs#calibrate" },
  );
  console.log("clarification-fix spec:", s ? "authored" : "FAILED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
