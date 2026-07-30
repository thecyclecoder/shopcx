import { loadEnv } from "./_bootstrap"; loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS="fdc11e10-b89f-4989-8b73-ed6526c4d906";
async function main(){
  const ok=await authorSpecRowStructured(
    WS,
    "mario-fix-authoring-emits-machine-checks-not-needs-human",
    {
      title: "Mario's fix-authoring must emit machine checks, not prose→needs_human (stop the fixes-as-phases oscillation)",
      why: "When the pre-merge spec-test on a built spec goes red, Mario appends a Fix phase — but its two fix-authoring functions build phases with only a PROSE verification string and no typed machine checks. The authoring chokepoint then falls back to converting that prose into checks where every line is exec_kind='needs_human', which can never auto-pass, so the machine-check gate keeps the spec red, so another Fix phase is appended: a structural oscillation that strands otherwise-green specs built-but-unmerged (observed live on the media-buyer neq-mock-fix spec — code green, test 63/63, but held ~2.5h and escalated to CEO). Mario cannot self-author the fix because its fix-spec authoring has the SAME defect (chicken-and-egg), so it must be landed by hand.",
      what: "Both Mario fix-authoring paths attach at least one machine-runnable check to every phase they author, so the machine-check gate passes and the fix phase can actually resolve.",
      summary: "In src/lib/mario.ts, authorMarioFixSpec (~1317) and repairSpecVerification (~1522) build phases with a prose `verification` and no `checks[]`; authorSpecRowStructured then routes the prose through parseVerificationBlobToChecks → all needs_human → the gate throws / the fix never passes. Attach a real checks[] (≥1 machine check per phase) in both.",
      owner: "platform",
      parent: '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: this is the recurring pipeline-reliability defect behind the fixes-as-phases loop that strands green specs; exactly the class this mandate owns. See [[../libraries/mario]] · [[../libraries/author-spec]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Attach machine checks in both Mario fix-authoring paths",
          why: "Prose-only verification becomes needs_human checks that can never pass; a machine check per phase breaks the oscillation.",
          what: "authorMarioFixSpec and repairSpecVerification each attach a typed checks[] (≥1 machine check) to every phase before calling authorSpecRowStructured.",
          body: "In src/lib/mario.ts: (1) authorMarioFixSpec (~line 1317) maps fixSpec.phases to `{title, body, verification, why, what}` — add a `checks` array with ≥1 machine-runnable check per phase (default a `{ kind:'auto', exec_kind:'tsc', params:null }` check; when the fix is scoped to a file/symbol, prefer a `grep` {pattern,path,expect:'present'} or a `unit_test` {script} that actually exercises the fix). (2) repairSpecVerification (~line 1522) maps realPhases similarly — add the same `checks` array per phase. The invariant: NEVER hand authorSpecRowStructured a phase whose only verification is prose (which parseVerificationBlobToChecks in src/lib/spec-phase-checks-table.ts turns into all-needs_human checks that trip assertEveryPhaseHasMachineCheck). Keep the prose in `verification` for humans, but ensure `checks[]` carries a machine check. Optionally (belt-and-suspenders) have parseVerificationBlobToChecks append a default tsc machine check when it would otherwise emit needs_human-only, so no caller can strand a spec. Update docs/brain/libraries/mario.md noting fix-phases now carry machine checks, in the same PR per CLAUDE.md.",
          verification: "- tsc clean\n- both authorMarioFixSpec and repairSpecVerification attach a checks[] to each phase (no prose-only fix phase reaches the gate)",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "mario.ts fix-authoring attaches a checks array to phases", kind: "auto", exec_kind: "grep", params: { pattern: "checks:", path: "src/lib/mario.ts", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#infra-devops-reliability" },
  );
  console.log(ok?"authored":"author write failed");
}
main().then(()=>process.exit(0)).catch(e=>{console.error(String(e).slice(0,400));process.exit(1);});
