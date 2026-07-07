/**
 * Two cs-owned specs from the Catherine Green $8.92 ticket (49ddd6c4):
 *  A) human-directives-hard-gates-over-ticket-ai — explicit human decisions
 *     (turn off AI, don't escalate, "I reviewed this — stand down") become HARD
 *     gates the handler + analyzer obey, and merges stop carrying control state.
 *  B) ticket-merge-summary-and-context-cap — on merge, summarize the prior
 *     history ONCE and stop re-sending the full 75-message blob to Opus every
 *     turn (the 2.06M cache-read / 217K cache-create that made one ticket $8.92).
 * Both STANDALONE, mandate-parented (no in-flight goal). Land in_review.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = await authorSpecRowStructured(
    WS,
    "human-directives-hard-gates-over-ticket-ai",
    {
      title: "Human directives are hard gates over the ticket AI — turn-off, don't-escalate, reviewed-lock; merges carry context, never control",
      why: "Catherine Green's ticket (49ddd6c4) cost $8.92 and reopened on CSAT because the ticket AI ignored human authority three ways. First, a merge propagated an agent-intervened flag onto the live ticket, flipping the orchestrator into a 'hold, take no actions' half-mode that suppressed the replacement playbook entirely — it never ran, so the AI just re-reassured her for 13 hours while no human was assigned. Second, a pinned 'do not escalate' note only flavors the analyzer's grade; the analyzer's force-escalation overrides never see it. Third, when a human reviews, closes, and unescalates a ticket, that edit bumps the ticket's updated timestamp, so the analyzer cron re-selects it, re-grades, and re-escalates — a close-reopen-close loop where the proxy-optimizer overrules its supervisor. Every one is the same north-star inversion: a human's explicit decision must beat the analyzer's heuristics, and a merge (a system action) must never switch off AI handling on the surviving ticket.",
      what: "Three explicit, persistent, NON-propagating per-ticket controls the handler + analyzer obey before any heuristic, cron, override, or merge: ai_disabled (turn off AI — handler hard-exits AND analyzer stands down), analyzer_locked (a human reviewed → analyzer never reopens/escalates this ticket again), and a hard 'do not escalate' directive that beats the analyzer's force-overrides. Plus the cleanup that made the trap possible: merges stop propagating agent_intervened, and the AGENT-CONTEXT half-mode is removed (handling is binary — AI on and fully handling, or AI off and silent).",
      summary: "**Brain refs:** [[../lifecycles/ai-analysis]] [[../libraries/ticket-analyzer]] [[../libraries/ticket-merge]] [[../libraries/sonnet-orchestrator-v2]] [[../tables/tickets]] [[../tables/ticket_messages]]. **Derived-from-ticket:** 49ddd6c4 (Catherine Green — $8.92, CSAT reopen). Grounded in: ticket-merge.ts:217 (agent_intervened propagation) + :229 (do_not_reply propagation as the shape to copy but NOT the propagation), sonnet-orchestrator-v2.ts:418 (AGENT CONTEXT half-mode) + :278 (is_ai_guidance load), src/lib/inngest/unified-ticket-handler.ts:718 (do_not_reply hard-exit pattern) + :1284 (playbook-supersede on real external human reply), ticket-analyzer.ts:783 applySeverityActions (force-overrides, no guidance) + :886 respect-human-closure (keyed on agent_intervened only) + :505 guidance load (grade-only), src/lib/inngest/ticket-analysis-cron.ts:50 (updated_at>last_analyzed_at reselect).",
      owner: "cs",
      parent: '[[../functions/cs]] — "Escalation triage quality" mandate: a mis-escalation is an analyzer-fix; the analyzer must never overrule a human\'s explicit close / lock / AI-off decision, and a merge must never switch AI handling off on the surviving ticket.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — ai_disabled: an explicit per-ticket 'turn off AI' hard gate (handler + analyzer), non-propagating",
          why: "The reviewer sometimes wants to own a ticket manually; today the only lever (agent_intervened) is implicit, over-broad, and leaks through merges. An explicit off-switch that a merge can never flip is the clean primitive.",
          what: "A per-ticket ai_disabled flag (+ ai_disabled_by/_at). When set: the ticket handler hard-exits (no orchestrator, no playbook) and the analyzer never reopens/escalates it. It is NEVER carried forward on merge. A dashboard 'Turn off AI' button sets it.",
          body: "Add ai_disabled (bool) + ai_disabled_by/ai_disabled_at to public.tickets ([[../tables/tickets]]). In src/lib/inngest/unified-ticket-handler.ts add an early hard-exit mirroring the existing do_not_reply short-circuit (:718) — if ai_disabled, sysNote + return, before orchestrator/playbook. In [[../libraries/ticket-analyzer]] skip analysis/escalation when ai_disabled (extend the respect-closure guard ~:886). In [[../libraries/ticket-merge]] do NOT propagate ai_disabled — the surviving ticket keeps its own value (default false). Add a 'Turn off AI' toggle on the ticket view (dashboard/tickets/[id]). Cite the do_not_reply short-circuit + the merge carry-forward block.",
          verification: "A ticket with ai_disabled=true: the handler returns early (no orchestrator/playbook run) and the analyzer cron skips it (no reopen/escalate). Merging a source ticket with ai_disabled=true INTO a target does NOT set the target's ai_disabled. The dashboard button flips the flag and an audit note lands.",
          status: "planned",
        },
        {
          title: "Phase 2 — analyzer_locked: a human review vetoes the analyzer, surviving the cron re-select loop",
          why: "The close→reopen→close loop exists because a human's manual close/unescalate BUMPS updated_at, which re-arms the cron (updated_at>last_analyzed_at) to re-grade and re-escalate. A one-shot suppression can't survive that; only a persistent lock can.",
          what: "A per-ticket analyzer_locked flag (+ locked_by/_at) set when a human manually closes/unescalates an escalated ticket (and via an explicit 'Lock from analyzer' button). The cron skips locked tickets; applySeverityActions refuses to reopen/escalate them — beating the force-overrides. Non-propagating on merge.",
          body: "Add analyzer_locked (bool) + locked_by/_at to public.tickets. In src/lib/inngest/ticket-analysis-cron.ts exclude analyzer_locked tickets from selection and stamp last_analyzed_at so a later updated_at bump can't re-select them (:50). In [[../libraries/ticket-analyzer]] applySeverityActions (:783) return before any reopen/escalate when analyzer_locked — checked BEFORE forceEscalate (:831) so a severe-type/threat-keyword override can't punch through. Set analyzer_locked when a human manually closes+unescalates a previously-escalated ticket (the veto), and expose an explicit 'Lock from analyzer / Approve handling' button. Do NOT propagate on merge. Cite the cron reselect predicate + applySeverityActions.",
          verification: "A human closes+unescalates an escalated ticket → analyzer_locked set → the next cron tick does NOT re-select it and it is never re-escalated (loop broken), even if the grade is ≤6 or a threat keyword is present. The lock does not transfer through a merge. Explicit button locks/unlocks with an audit trail.",
          status: "planned",
        },
        {
          title: "Phase 3 — directives beat the overrides; retire agent_intervened as a gate; merges carry context, never control",
          why: "Two of the three failures came from soft signals being trampled by hard heuristics (guidance only flavors the grade; force-overrides ignore it) and from a merge silently switching handling mode. This phase makes explicit directives authoritative and strips the phantom gate.",
          what: "Pass the pinned is_ai_guidance 'do not escalate' directive into applySeverityActions as a hard suppressor of force-escalation; stop propagating agent_intervened on merge; delete the AGENT-CONTEXT half-mode so handling is binary (on/off), never a silent hold.",
          body: "In [[../libraries/ticket-analyzer]]: thread the guidance block (already loaded at :505) into applySeverityActions and hard-suppress force-escalation when it carries an explicit no-escalate directive (audit-note the suppression). In [[../libraries/ticket-merge]]: remove the agent_intervened carry-forward (:217) — a merge conveys the customer's full CS journey (context) but NEVER control. In [[../libraries/sonnet-orchestrator-v2]]: remove the AGENT CONTEXT 'respond but hold, take no actions' half-mode (:418); with ai_disabled (Phase 1) as the real off-switch and playbooks running by default, the half-mode is the empty-reassurance loop and is no longer needed. Keep agent_intervened only as passive context (be aware of a prior human commitment), never as a gate. Cite applySeverityActions + the merge carry-forward + the AGENT CONTEXT block.",
          verification: "A pinned 'do not escalate' note prevents the analyzer from reopening even when a severe-type issue or threat keyword is present (force-override suppressed + audited). Merging a source ticket with agent_intervened=true does NOT gate the target's handling — its playbook still runs. No code path emits the 'an agent will be back shortly, no actions taken' half-mode reply; a ticket is either fully AI-handled or ai_disabled.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "cs#escalation-triage" },
  );
  console.log("spec A (human-directives-hard-gates-over-ticket-ai):", a ? "authored" : "FAILED");

  const b = await authorSpecRowStructured(
    WS,
    "ticket-merge-summary-and-context-cap",
    {
      title: "Summarize once at merge, then stop re-sending the full history to Opus every turn (kill the cache re-cost loop)",
      why: "Catherine's ticket (49ddd6c4) cost $8.92 — and 86% of it (2.06M cache-read + 217K cache-create tokens) was NOT reasoning, it was re-caching and re-reading a 75-message merged history four Opus rounds deep on every one-line reply. Each auto-merge/new message shifts the prompt prefix, invalidating the cache, so we re-pay cache-creation (1.25x input, ai-usage.ts usageCostCents) and re-read the whole blob every turn. An unresolved high-LTV ticket (which forces Opus) is the worst case: big context x many rounds x many replies x cache re-creation. The context is the cost engine, independent of whether the reasoning is Opus or Sonnet.",
      what: "On merge, generate ONE durable summary of the pre-merge history and thereafter feed the orchestrator a STABLE prefix (summary + only-messages-since) instead of re-sending all N merged messages — so the cache prefix stops being invalidated every turn, a rolling tail keeps the 'since' window bounded, and a hard cap plus a no-progress guard prevent a stuck ticket from re-costing its history indefinitely.",
      summary: "**Brain refs:** [[../libraries/sonnet-orchestrator-v2]] [[../libraries/ticket-merge]] [[../libraries/ai-usage]] [[../tables/tickets]] [[../tables/ticket_messages]]. **Derived-from-ticket:** 49ddd6c4 (measured $8.92 via usageCostCents; input 93,813 / output 7,462 / cache_create 216,507 / cache_read 2,058,493). Grounded in: src/lib/ticket-merge.ts (merge point that pulls 50/60/75 messages forward), sonnet-orchestrator-v2.ts buildPreContext (the merged-message fetch fed to Opus each round), ai-usage.ts usageCostCents (cache-create billed at 1.25x input, cache-read at 10%). Pairs with [[../specs/human-directives-hard-gates-over-ticket-ai]] (which prevents the endless replies in the first place).",
      owner: "cs",
      parent: '[[../functions/cs]] — "Fix weird tickets fast, calibrate so they don\'t recur" mandate: a long-running merged ticket must not re-cost its entire history to Opus on every turn.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — one-time durable merge summary",
          why: "The 75-message blob is only needed as CONTEXT, not verbatim every turn; a single compact state summary captures it once and never has to be re-derived.",
          what: "When tickets merge, generate one summary (Sonnet — summarization is cheap and easy) of the pre-merge history and store it durably on the surviving ticket.",
          body: "In [[../libraries/ticket-merge]], after carrying messages forward, generate a compact summary of the pre-merge thread via Sonnet and persist it on public.tickets (e.g. merge_summary + merge_summary_at) ([[../tables/tickets]]). Summarize STATE, not chat: the customer's issue, confirmed facts (e.g. address = Kirkland), actions taken, and open items — so downstream turns read state instead of re-deriving it (the 'lock-in' idea). One summary per merge event; re-running the merge summarizes only newly-merged content. Cite the merge point + the tickets columns.",
          verification: "A merge writes exactly one merge_summary capturing the pre-merge issue/state (facts + actions), and does not re-summarize unchanged history on a later unrelated update. The summary is materially shorter than the raw merged messages (order-of-magnitude fewer tokens).",
          status: "planned",
        },
        {
          title: "Phase 2 — stable-prefix context: summary + messages-since, with a rolling tail",
          why: "Cache-creation is re-paid because every new message shifts the prompt prefix; a FROZEN summary prefix caches once and is read cheaply thereafter, and a rolling tail stops the 'since' window from itself growing back to 75.",
          what: "The orchestrator assembles context as [frozen merge summary] + [messages since the summary], not the full merged history; every K new messages, the tail is folded back into the summary so it stays bounded.",
          body: "In [[../libraries/sonnet-orchestrator-v2]] buildPreContext, when a merge_summary exists, send it as a stable cache-prefix followed by only the messages after merge_summary_at — not all N merged messages. Every K new messages (or T tokens), re-compact the tail into the summary and advance merge_summary_at so the 'since' window stays small and the prefix stays stable. Preserve the existing is_ai_guidance out-of-window fetch (:278) so pinned guidance is never lost. Cite the context-assembly path + usageCostCents cache accounting.",
          verification: "For a merged ticket, a new customer reply sends the frozen summary as a cached prefix (cache_read, not re-created) plus only the new tail — measured cache_creation per turn drops sharply versus re-sending the full history. After K new messages the tail is folded in and merge_summary_at advances (tail bounded). Pinned guidance still reaches the model.",
          status: "planned",
        },
        {
          title: "Phase 3 — hard context cap + no-progress guard, with before/after cost measurement",
          why: "Even with a summary, a pathological ticket shouldn't re-cost its history forever; and a ticket making zero state progress across many Opus runs should stop escalating model/context (the supervisable-autonomy rail).",
          what: "A hard cap on raw messages ever sent per turn, and a guard that stops escalating to Opus / re-sending large context when a ticket has had M orchestrator runs with no state change — logged, not silent.",
          body: "Cap the raw-message window fed per turn at N (beyond N, rely on the summary). Add a no-progress guard: if a ticket has had M orchestrator runs without a state change (no new action, no resolution), stop re-escalating model/context and surface it (ties to the analyzer / CS-director loop signals) rather than paying for another full-context Opus pass. Log any truncation/cap so bounded coverage is never silent. Replay ticket 49ddd6c4 through the new path and record the cost delta. Cite usageCostCents + the orchestrator run loop.",
          verification: "Replaying 49ddd6c4 through the new assembly yields a large measured cost reduction versus the $8.92 baseline (report the number). A ticket exceeding N raw messages still gets full context via the summary (no information loss) and logs the cap. A no-progress ticket stops escalating context/model and is surfaced instead of silently re-charged.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "cs#calibrate" },
  );
  console.log("spec B (ticket-merge-summary-and-context-cap):", b ? "authored" : "FAILED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
