/**
 * check:graduate-rail-wired — the cold-scaler graduate rail must have a live caller.
 *
 * The 2026-08-25 finding: `graduateCrownedWinnerToScaler`'s Gate 3 refuses unless a
 * `media_buyer_cold_scaler_arming_authorization` row exists and is allowed + unexpired. The ONLY
 * writer of that row is `runColdScalerArmingGate` — and it had ZERO CALL SITES. So the row never
 * existed, Gate 3 could only ever deny, and the graduate was structurally unreachable: 5 crowned
 * winners, 0 with a `scaler_meta_adset_id`, and the single live scaler campaign seeded by hand.
 *
 * Identical shape to the cooldown rail that was configured but never threaded (see
 * `_check-scale-rails-wired.ts`). A gate nothing evaluates is not a gate, it is a wall — and it
 * fails SILENTLY, because a rail that never runs raises no error.
 *
 * This guard asserts three things a regression would break:
 *   1. `runColdScalerArmingGate` is CALLED from the media-buyer runner (not merely exported).
 *   2. `runGraduateForCrownedWinners` is CALLED (the graduate itself is reachable).
 *   3. The runner's skip reasons are SURFACED, not discarded — the original call site threw the
 *      result away while its own comment claimed every skip was audited, which is why the failure
 *      left no trace.
 *
 * Run: npx tsx scripts/_check-graduate-rail-wired.ts
 */
import { readFileSync } from "node:fs";

const AGENT = "src/lib/media-buyer/agent.ts";
const GATE = "src/lib/media-buyer/cold-scaler-arming-gate.ts";

function fail(msg: string): never {
  console.error(`\n❌ [check:graduate-rail-wired] ${msg}\n`);
  process.exit(1);
}

const agent = readFileSync(AGENT, "utf8");
const gate = readFileSync(GATE, "utf8");

// 0. The writer still exists and still owns the authorization row.
if (!/export async function runColdScalerArmingGate\b/.test(gate)) {
  fail(`${GATE} no longer exports runColdScalerArmingGate — the arming authorization has no writer.`);
}
if (!gate.includes("media_buyer_cold_scaler_arming_authorization")) {
  fail(`${GATE} no longer touches media_buyer_cold_scaler_arming_authorization.`);
}

// 1. The gate is CALLED, not just imported. `import { runColdScalerArmingGate }` alone is exactly
//    the state that produced the bug, so an import does not count as a call.
const callSites = [...agent.matchAll(/\brunColdScalerArmingGate\s*\(/g)].length;
if (callSites < 1) {
  fail(
    `runColdScalerArmingGate has NO call site in ${AGENT}.\n` +
      `   Nothing would write media_buyer_cold_scaler_arming_authorization, so the graduate's\n` +
      `   Gate 3 can only ever deny and no crowned winner can reach the cold scaler.\n` +
      `   This is the exact regression the 2026-08-25 fix repaired.`,
  );
}

// 2. The graduate itself is reachable.
const graduateCalls = [...agent.matchAll(/\brunGraduateForCrownedWinners\s*\(/g)].length;
// One match is the function declaration; a live caller makes two or more.
if (graduateCalls < 2) {
  fail(`runGraduateForCrownedWinners is declared but never called from ${AGENT}.`);
}

// 3. The runner's skips are surfaced rather than discarded.
if (!/cold_scaler_graduate_runner_skipped/.test(agent)) {
  fail(
    `${AGENT} no longer emits 'cold_scaler_graduate_runner_skipped'.\n` +
      `   The graduate runner raises its own skip reasons (no_active_cohort / no_meta_token /\n` +
      `   no_meta_account_act_id / mint_failed / no_creative_or_adset). The original call site\n` +
      `   DISCARDED that result while claiming every skip was audited — which is why the graduate\n` +
      `   could fail repeatedly and leave nothing to find. Keep the skips visible.`,
  );
}

console.log(
  `✓ check-graduate-rail-wired — arming gate called (${callSites} site${callSites === 1 ? "" : "s"}), ` +
    `graduate reachable, runner skips surfaced.`,
);
