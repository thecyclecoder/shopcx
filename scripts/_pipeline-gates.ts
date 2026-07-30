import { createAdminClient } from "./_bootstrap";
import { isAutoMergeEnabled, isInngestSyncActive } from "../src/lib/github-pr-resolve";
import { getBranchBuildSuccess } from "../src/lib/agent-jobs";
import { isSpecAccumulationComplete } from "../src/lib/specs-table";
import { getSpecTestStateForBranch } from "../src/lib/spec-test-runs";
import { getSecurityStateForBranch } from "../src/lib/security-agent";

const admin = createAdminClient();

const BRANCHES = [
  "claude/build-ticket-decision-workprobe-grace-merge-remapped-inbounds-by-t",
  "claude/build-control-tower-ticket-decision-workprobe-defer-messages-on-fresh-parent-ticket",
  "claude/build-mario-eligible-never-enqueued-chunk-build-scan",
];

async function main() {
  console.log("autoMergeEnabled:", await isAutoMergeEnabled(admin));
  console.log("inngestSyncActive:", await isInngestSyncActive(admin));

  for (const branch of BRANCHES) {
    console.log(`\n=== ${branch}`);
    const gate = await getBranchBuildSuccess(branch, admin);
    console.log("buildGate:", JSON.stringify(gate));
    if (gate.workspaceId && gate.specSlug) {
      const acc = await isSpecAccumulationComplete(gate.workspaceId, gate.specSlug);
      console.log("accumulation:", JSON.stringify(acc));
      const st = await getSpecTestStateForBranch(gate.workspaceId, gate.specSlug, branch);
      console.log("specTest cleanMachinePass:", st.cleanMachinePass, "latest:", JSON.stringify(st.latest?.summary ?? null), "verdict:", st.latest?.verdict ?? null, "branch:", (st.latest as any)?.branch ?? null);
    }
    const sec = await getSecurityStateForBranch(admin, branch);
    console.log("security:", JSON.stringify(sec).slice(0, 400));
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
