import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "founder-escalations-reach-the-founder",
    {
      title: "Founder escalations must actually reach the founder — stop swallowing recommendation-only cards",
      why:
        "On 2026-07-20 the CS director escalated a ticket to the founder, and the escalation reached nobody. Two independent defects stacked. First, the code that raises a founder approval arms an Eve cockpit session — which is what SENDS the 'I am online, tap in' text — BEFORE the guard that decides whether there is anything to approve. That guard then correctly determined the director's recommendation was a suggestion rather than an auto-fireable action, and bailed without opening a card. The founder was texted into an empty cockpit; the session recorded zero approval cards and expired untouched two and a half hours later. Second, that guard bails on the explicit assumption that the CEO dashboard card remains as the durable record — but the approvals reconcile sweep dismisses any approval card whose originating job is not currently awaiting approval, and a director-call job is already completed at the moment it mints its card. The card was dismissed unread within a tick, and the approvals feed only shows undismissed cards. Every one of the eight founder escalations ever minted is now in the dismissed state. The founder's own standing directive is that anything the director seeks from him should be a straight-up approval and never a silent card he has to go hunt for; today it is worse than silent, because a text goes out promising something that is not there.",
      what:
        "Escalation cards stop being treated as job-gated approvals by the reconcile sweep, so they survive to be read. The founder-approval path decides whether there is anything to approve BEFORE it arms a session and texts, so a text is never sent about a card that will not exist. A recommendation-only escalation still reaches the founder — as a durable card that stays put — instead of vanishing between the two.",
      summary:
        "Two fixes. (1) `reconcileApprovalInbox` (src/lib/agents/approval-inbox.ts:1014) dismisses every live `agent_approval_request` whose `metadata.agent_job_id` is absent from the `status='needs_approval'` set; a `cs-director-call` job is `completed` when it mints its card, so escalation cards are dismissed unread. Exempt notifications carrying `metadata.escalation_kind` — they are keyed on their own reason and the park-card path already has `reconcileStaleParkCards`. (2) `raiseFounderApproval` (src/lib/june-remedy-approval.ts) calls `getActiveSession`/`armSession` before the `planRemedyExecution` executable-remedy guard; reorder so the guard runs first.",
      owner: "platform",
      parent:
        '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: the approvals inbox and the cockpit paging path are shared platform rails that every department escalates through. A rail that silently drops the escalations routed onto it, and pages the founder about cards that do not exist, is a reliability defect in the platform itself.',
      blocked_by: [],
      human_review:
        "After ship, have a director escalate a recommendation-only verdict and confirm the card is still present and readable in the approvals inbox an hour later, and that no cockpit text went out for it.",
      phases: [
        {
          title: "Phase 1 — escalation cards survive the reconcile sweep",
          why:
            "This is the defect that makes every other escalation path unreliable, because it destroys the fallback that the other paths explicitly depend on. The sweep's rule is right for routed approval requests, which are gated on a job sitting in the awaiting-approval state — but an escalation card is not that. Its originating job is finished by definition the moment the card is written, so the sweep reads every escalation as stale and dismisses it within a tick.",
          what:
            "The dismiss loop skips notifications that carry an escalation kind, so a director or system escalation stays in the inbox until it is actually dealt with.",
          body: [
            "In `src/lib/agents/approval-inbox.ts` `reconcileApprovalInbox`, the dismiss loop (:1014) flips `dismissed=true` on any live `agent_approval_request` whose `metadata.agent_job_id` is not in `openJobIds` (built from `status='needs_approval'`). Skip any notification carrying a `metadata.escalation_kind`.",
            "",
            "- Rationale to encode in the comment: an escalation card is NOT a routed approval request keyed on a job's approval state — its job is completed by construction when the card is minted. The stale-park cards already have their own dedicated reconciler (`reconcileStaleParkCards`), which is the correct pattern for reason-keyed cards; this change stops the job-keyed loop from reaching across into cards it does not own.",
            "- Leave the existing bail-on-failed-read safety at the top of the sweep exactly as-is. That guard was added because one transient read error wiped the whole inbox, and it must not regress.",
            "- Verified state to be aware of while building: every founder-escalation card minted to date is currently `dismissed=true`, and the most recent one is also `read=false`, i.e. never seen. Do NOT bulk-undismiss the historical rows as part of this phase — the older ones have been dealt with, and resurrecting them would bury the live ones. If any historical card needs restoring it ships separately as an idempotent backfill script per the CLAUDE.md ship-time-backfill convention.",
            "",
            "Update `docs/brain/libraries/` for the approvals-inbox reconciler to state which card classes each loop owns.",
          ].join("\n"),
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- The dismiss loop is aware of escalation-kind cards.",
            "- The transient-read safety bail is still present.",
            "- The approval-router suite still passes.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "the dismiss loop exempts escalation-kind cards",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "escalation_kind", path: "src/lib/agents/approval-inbox.ts", expect: "present" },
            },
            {
              position: 3,
              description: "the bail-on-failed-read inbox safety is still in place",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "skipping reconcile to protect the inbox", path: "src/lib/agents/approval-inbox.ts", expect: "present" },
            },
            {
              position: 4,
              description: "approval-router suite green",
              kind: "auto",
              exec_kind: "unit_test",
              params: { script: "test:approval-router" },
            },
          ],
        },
        {
          title: "Phase 2 — never text the founder about a card that will not exist",
          why:
            "The founder got a text saying to tap in, tapped in, and found an empty cockpit — because arming the session is what sends the text, and it happens before the code decides there is nothing to show. A false page is worse than no page: it spends the founder's attention and trains him to distrust the channel. The decision of whether a one-tap approval is possible depends only on the recommendation itself, so nothing forces it to happen after the session is armed.",
          what:
            "The executable-remedy decision is made first, from the recommendation alone. Only a recommendation that can actually be fired arms a session and sends a text; anything else goes straight to the durable card path with no page.",
          body: [
            "In `src/lib/june-remedy-approval.ts` `raiseFounderApproval`, the cockpit session is resolved and armed (`getActiveSession` / `armSession`) before the executable-remedy guard runs. Arming is what triggers the outbound text, so a non-executable recommendation still pages the founder and then returns `escalated_recommendation_only` without ever opening a card.",
            "",
            "- Extract the decision into a small exported pure predicate — `canOfferOneTapApproval(remedy)` — that wraps the existing `planRemedyExecution` check from `src/lib/cs-director.ts`, so it is unit-testable and cannot drift from the executor that would actually fire the remedy. Keeping it delegated to `planRemedyExecution` is the point: the guard must stay exactly as strict as the executor, which is why the current check exists at all.",
            "- Call it FIRST in `raiseFounderApproval`. On false: post the internal note, leave the ticket escalated to the owner, return `escalated_recommendation_only`, and arm nothing / text nothing.",
            "- On true: proceed to the existing session-resolution, card-open and SMS path unchanged.",
            "- Do not weaken the guard itself. It exists because opening a one-tap card for a non-executable recommendation makes the founder's Approve tap fail instantly with a malformed-remedy error, which is its own reported defect.",
            "",
            "With Phase 1 shipped, the no-page branch is now safe: the durable CEO card it falls back to actually survives.",
          ].join("\n"),
          verification: [
            "- On the branch, `npx tsc --noEmit` → expect clean.",
            "- The one-tap decision is an extracted, testable predicate.",
            "- The predicate still delegates to the executor's own planner rather than re-implementing it.",
            "- The cs-director suite still passes.",
          ].join("\n"),
          status: "planned",
          checks: [
            { position: 1, description: "tsc clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "the one-tap decision is extracted as a testable predicate",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "canOfferOneTapApproval", path: "src/lib/june-remedy-approval.ts", expect: "present" },
            },
            {
              position: 3,
              description: "the predicate still delegates to the executor's planner",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "planRemedyExecution", path: "src/lib/june-remedy-approval.ts", expect: "present" },
            },
            {
              position: 4,
              description: "cs-director suite green",
              kind: "auto",
              exec_kind: "unit_test",
              params: { script: "test:cs-director" },
            },
          ],
        },
      ],
    },
    "planned",
    {
      intendedStatusSetBy: "ceo",
      parentKind: "mandate",
      parentRef: "platform#infra-devops-reliability",
    },
  );
  console.log(ok ? "authored: founder-escalations-reach-the-founder" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
