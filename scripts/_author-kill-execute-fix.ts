import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "media-buyer-decided-kills-must-execute-on-meta-not-just-be-recorded",
    {
      title:
        "Bianca's decision-tree kills/promotes must EXECUTE on Meta — a 'decided' iteration_action that never calls the Meta pause API leaves losing ads live and bleeding",
      why: "Bianca's decision-tree correctly identifies and DECIDES to pause losing test ads, but the decision is only recorded — it never executes against Meta, so the losing ads stay ACTIVE and keep spending. Four duds (three Creatine Prime, one Ashwavana Guru Focus) were each decided-to-pause across the 16:00/18:00/20:00 passes with ROAS 0.00 on $325–354 spend, yet all four stayed live and had to be paused by hand. The kill loop writes the pause decision to the ledger and even emits a 'paused loser' audit line, but never calls the Meta pause primitive — so it CLAIMS a pause it never made. This is a direct violation of the no-false-promises principle (no claim ships until executed + verified) and of supervisable autonomy: the tool reports an action it didn't take, and money bleeds on ads the system already ruled dead. Compounding it, the ads-supervisor's coverage check counts a decided-but-unfired action as 'handled', so the watcher meant to catch missed kills is blind to exactly this failure. The prior decision-tree spec shipped the DECIDE half and folded without wiring the EXECUTE half.",
      what: "Wire the media-buyer runner's decided kills/promotes/unpauses to actually call the Meta status API, flip the ledger row to executed on success (with the Meta response), keep it un-executed and escalate on failure, and emit the 'action taken' audit line ONLY after a successful execute. Then fix the ads-supervisor coverage check so only an EXECUTED action counts as covered — a decided-but-unfired kill is surfaced as a missed kill, not hidden.",
      summary:
        "Two-phase growth fix. Phase 1: in the media-buyer runner kill/promote loops, after upserting the iteration_actions row with status='decided', call updateObjectStatus (the exported Meta pause/unpause primitive) with the workspace's Meta token, set status='executed' + executed_at + external_result on Graph success, keep 'decided' + escalate on failure, and move the director_activity 'paused_loser'/'promoted_winner' emit to AFTER a successful execute (no false claim). Phase 2: the ads-supervisor coverage check must require status='executed' — a 'decided'-only action no longer counts as covered, so a missed execution is flagged.",
      owner: "growth",
      parent:
        '[[../functions/growth]] — "Static-ad optimization" mandate: the test→scale loop must actually cut true losers, not merely record that it decided to; a decided-but-unexecuted kill leaves a losing ad spending and reports a pause that never happened. Sibling to the folded [[../specs/media-buyer-kill-on-decision-tree-retire-roas-floor]] (which shipped the decide half). See [[../libraries/media-buyer-agent]] and [[../libraries/ads-supervisor]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Execute the decided kill/promote/unpause on Meta and only then claim it",
          why: "The kill loop records a pause decision and emits a 'paused loser' audit line but never calls the Meta pause API, so the ad stays live while the system claims it was paused.",
          what: "Call the Meta status primitive for each decided action, flip the ledger to executed on success, escalate on failure, and emit the audit line only after a successful execute.",
          body: "In src/lib/media-buyer/agent.ts, in the armed kill loop (the `for (const a of plan.kill)` block, ~line 1111, and the sibling promote/unpause loop) — after upserting the iteration_actions row with status='decided': fetch the workspace Meta token via getMetaUserToken (src/lib/meta-ads.ts:25), then call updateObjectStatus(token, a.targetObjectId, 'PAUSED') for a kill (and 'ACTIVE' for an unpause/promote-reactivate) — the exported primitive at src/lib/meta-ads.ts:344 that POSTs the object status to Graph. On a Graph success ({success:true}) update the same iteration_actions row to status='executed', executed_at=now(), external_result=<response json>. On a thrown/failed Graph call, leave status='decided' (or set a 'failed' status), write the error to external_result, and ESCALATE (reuse the media-buyer escalation path) — NEVER stamp executed on failure. Move the director_activity 'media_buyer_paused_loser' / 'media_buyer_promoted_winner' emit + stampCreativeOutcome to AFTER a successful execute so the audit trail never claims an action that did not happen (no-false-promises). Keep the shadow-mode branch (policy.mode==='shadow') emit-only — this wiring is armed-mode only. Add a unit test asserting: armed kill → updateObjectStatus called with (adsetId,'PAUSED') AND the row transitions decided→executed; a Graph failure → row stays un-executed + escalation emitted + no paused_loser claim. Update docs/brain/libraries/media-buyer-agent.md per CLAUDE.md.",
          verification:
            "- tsc clean\n- the media-buyer kill/promote loop calls updateObjectStatus with the Meta token\n- a decided action transitions to executed (executed_at set) on Graph success; stays un-executed + escalates on failure\n- unit test covers execute-success and execute-failure paths",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "the media-buyer runner calls the Meta status primitive to execute a decided action",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "updateObjectStatus", path: "src/lib/media-buyer/agent.ts", expect: "present" },
            },
            {
              position: 3,
              description: "a decided action is stamped executed after the Meta call",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "executed_at", path: "src/lib/media-buyer/agent.ts", expect: "present" },
            },
            {
              position: 4,
              description: "unit test covers execute-success and execute-failure",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "updateObjectStatus", path: "src/lib/media-buyer/agent.test.ts", expect: "present" },
            },
          ],
          status: "planned",
        },
        {
          title: "Phase 2 — Supervisor coverage requires EXECUTED, so a decided-but-unfired kill is flagged not hidden",
          why: "The ads-supervisor counts a decided-but-unfired action as covered, so the watcher meant to catch missed kills is blind to exactly the execution gap this spec fixes.",
          what: "Change the coverage check to require status='executed'; a decided-only action no longer satisfies coverage and is surfaced as a missed kill/promote.",
          body: "In src/lib/ads-supervisor.ts (the iteration_actions coverage check ~line 281-298 that today counts both 'decided' and 'executed' as covered): require status='executed' for an action to count as coverage. A 'decided'-only row (a decision the runner recorded but never executed on Meta) MUST NOT satisfy the pass's coverage test — so the missed-kill / missed-promote finding fires and the gap becomes visible, consistent with the no-false-promises principle ([[../specs/eliminate-false-promises-no-claim-ships-until-executed-and-verified]]). Keep the 14-day scoping + object_id/workspace_id filter. Add/extend a unit test: an adset with only a 'decided' pause row is reported as an uncovered dud; an 'executed' pause row counts as covered. Update docs/brain/libraries/ads-supervisor.md per CLAUDE.md (coverage = executed, not merely decided).",
          verification:
            "- tsc clean\n- ads-supervisor coverage requires status='executed'\n- a decided-only action is reported as an uncovered miss (unit test)",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            {
              position: 2,
              description: "the coverage check gates on the executed status",
              kind: "auto",
              exec_kind: "grep",
              params: { pattern: "executed", path: "src/lib/ads-supervisor.ts", expect: "present" },
            },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "growth#static-ad-optimization" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 600)); process.exit(1); });
