/**
 * god-mode-plan — the plan-scoped-approval primitive for the god-mode box lane.
 *
 * Plan-scoped approvals hotfix (docs/brain/libraries/god-mode-permission-gate.md
 * § Plan-scoped approvals). A "plan" is ONE plain-language, founder-approved unit
 * of work. Instead of the box rubber-stamping every Write/Bash keystroke, it:
 *   1) does read-only investigation (auto-allowed, no card),
 *   2) opens ONE plan describing the decision + steps → the founder sees a single
 *      "Plan" card in the cockpit and approves it once,
 *   3) does all the non-destructive mechanical work, which the gate auto-allows
 *      while the plan is open (destructive calls STILL individually PIN-gate).
 *
 * This script is ALLOWLISTED in scripts/god-mode-permission-gate.ts so invoking
 * it never itself lands a card — the ONLY card is the plan row it opens (for
 * `open`) and it blocks here polling that row exactly like the gate does.
 *
 * Usage (run inside a god-mode session; GOD_MODE_SESSION_ID is in the env):
 *   npx tsx scripts/god-mode-plan.ts open "<plain-language decision>" ["step 1" "step 2" ...]
 *   npx tsx scripts/god-mode-plan.ts close
 *   npx tsx scripts/god-mode-plan.ts status
 *
 * Keep the title/steps free of the shell metacharacters ; & | ` $ < > (spell out
 * "and"/"greater than") so the allowlisted invocation stays auto-allowed.
 *
 * Exit codes: 0 approved/closed/ok · 1 denied or error · 2 the founder asked a
 * question (printed to stdout — answer it in the transcript, then re-open).
 */
import { createAdminClient } from "./_bootstrap";
import { openPlan, getApproval, isSessionArmed, setActivePlan, getActivePlan } from "../src/lib/god-mode";

const POLL_MS = 2000;

async function main() {
  const sessionId = process.env.GOD_MODE_SESSION_ID;
  if (!sessionId) {
    console.error("god-mode-plan: GOD_MODE_SESSION_ID not set (run inside a god-mode session).");
    process.exit(1);
  }
  const admin = createAdminClient();
  const cmd = (process.argv[2] || "").toLowerCase();

  if (cmd === "close") {
    await setActivePlan(admin, sessionId, null);
    console.log("PLAN CLOSED — subsequent non-safe calls gate individually again.");
    process.exit(0);
  }

  if (cmd === "status") {
    const plan = await getActivePlan(admin, sessionId);
    if (!plan) { console.log("No open plan. Non-safe calls gate individually."); process.exit(0); }
    console.log(`Open plan ${plan.id}: ${plan.preview}`);
    process.exit(0);
  }

  if (cmd !== "open") {
    console.error(`god-mode-plan: unknown command "${cmd}". Use open | close | status.`);
    process.exit(1);
  }

  const title = (process.argv[3] || "").trim();
  const steps = process.argv.slice(4).map((s) => s.trim()).filter(Boolean);
  if (!title) {
    console.error('god-mode-plan open: a plain-language title is required, e.g. open "Dismiss the 4 stale approvals".');
    process.exit(1);
  }

  if (!(await isSessionArmed(admin, sessionId))) {
    console.error("god-mode-plan: session is not armed.");
    process.exit(1);
  }

  const { data: session } = await admin
    .from("god_mode_sessions")
    .select("workspace_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) { console.error("god-mode-plan: session not found."); process.exit(1); }

  const plan = await openPlan(admin, {
    sessionId,
    workspaceId: (session as { workspace_id: string }).workspace_id,
    title,
    steps,
  });
  console.log(`Plan opened (${plan.id}). Waiting for the founder to approve in the cockpit…`);

  // Poll the plan row exactly like the gate polls a tool approval.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!(await isSessionArmed(admin, sessionId))) {
      console.error("god-mode-plan: session was disarmed while waiting for plan approval.");
      process.exit(1);
    }
    const fresh = await getApproval(admin, plan.id);
    if (!fresh) { console.error("god-mode-plan: plan row disappeared."); process.exit(1); }
    if (fresh.status === "pending") continue;
    if (fresh.status === "approved") {
      await setActivePlan(admin, sessionId, plan.id);
      console.log("PLAN APPROVED — non-destructive calls in this plan now auto-allow. Run `god-mode-plan.ts close` when done (auto-clears next turn).");
      process.exit(0);
    }
    if (fresh.status === "denied") {
      console.log("PLAN DENIED — stop and reply in the transcript.");
      process.exit(1);
    }
    if (fresh.status === "asked") {
      console.log(`FOUNDER ASKED: ${fresh.question_text ?? "(no question)"} — answer in the transcript, then re-open the plan.`);
      process.exit(2);
    }
  }
}

main().catch((err) => {
  console.error(`god-mode-plan error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
