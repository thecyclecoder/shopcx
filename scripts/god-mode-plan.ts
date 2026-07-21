/**
 * god-mode-plan — the box's CEO-grade DECISION primitive for the god-mode lane
 * (docs/brain/lifecycles/god-mode.md).
 *
 * God-mode does all ordinary work with no approval. When it hits a genuine
 * CEO-grade decision — shipping a hotfix to production, submitting a spec to the
 * build pipeline, dismissing/deleting business items, spending money, anything
 * irreversible or strategic — it ESCALATES that ONE decision to the founder in
 * plain language and waits. This primitive is how it does that.
 *
 *   npx tsx scripts/god-mode-plan.ts decide "<category>" "<plain question>" ["extra detail"]
 *
 * `<category>` is a short reusable label (e.g. dismiss-stale-approvals, ship-hotfix,
 * submit-spec, apply-db-fix). If the founder has tapped "Don't ask again" for that
 * category, this AUTO-APPROVES instantly (prints AUTO-APPROVED, exit 0) and posts a
 * note to the transcript — no card. Otherwise it raises ONE plain-language decision
 * card and blocks until the founder decides in the cockpit.
 *
 * Exit codes: 0 approved (or auto-approved) · 1 denied/error · 2 the founder asked a
 * question (printed — answer it in your reply, then re-run if still needed).
 *
 * Keep the category/question/detail free of the shell metacharacters ; & | ` $ < > .
 *
 * (Legacy `open`/`close`/`status` plan subcommands are retained as thin aliases for
 * back-compat; the CEO-grade model uses `decide`.)
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import {
  openDecision,
  getApproval,
  isSessionArmed,
  isCategoryStandingGranted,
  appendNote,
  openPlan,
  setActivePlan,
  getActivePlan,
} from "../src/lib/god-mode";

const POLL_MS = 2000;

async function pollApproval(admin: ReturnType<typeof createAdminClient>, sessionId: string, approvalId: string): Promise<"approved" | "denied" | "asked"> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (!(await isSessionArmed(admin, sessionId))) throw new Error("session was disarmed while waiting.");
    const fresh = await getApproval(admin, approvalId);
    if (!fresh) throw new Error("decision row disappeared.");
    if (fresh.status === "pending") continue;
    if (fresh.status === "approved") return "approved";
    if (fresh.status === "denied") return "denied";
    return "asked";
  }
}

async function main() {
  const sessionId = process.env.GOD_MODE_SESSION_ID;
  if (!sessionId) {
    console.error("god-mode-plan: GOD_MODE_SESSION_ID not set (run inside a god-mode session).");
    process.exit(1);
  }
  const admin = createAdminClient();
  const cmd = (process.argv[2] || "").toLowerCase();

  const { data: session } = await admin.from("god_mode_sessions").select("workspace_id").eq("id", sessionId).maybeSingle();
  if (!session) { console.error("god-mode-plan: session not found."); process.exit(1); }
  const workspaceId = (session as { workspace_id: string }).workspace_id;

  // ── decide — the CEO-grade escalation ────────────────────────────────────
  if (cmd === "decide") {
    const category = (process.argv[3] || "").trim();
    const question = (process.argv[4] || "").trim();
    const detail = (process.argv[5] || "").trim();
    if (!category || !question) {
      console.error('god-mode-plan decide: need a category and a plain question, e.g. decide "dismiss-stale-approvals" "Ok to dismiss the 4 stale approvals in your inbox?"');
      process.exit(1);
    }
    if (!(await isSessionArmed(admin, sessionId))) { console.error("god-mode-plan: session is not armed."); process.exit(1); }

    // Standing grant? Auto-approve without a card.
    if (await isCategoryStandingGranted(admin, workspaceId, category)) {
      await appendNote(admin, sessionId, `Auto-approved per your standing approval for "${category}": ${question}`);
      console.log(`AUTO-APPROVED (standing approval for "${category}"). Proceed.`);
      process.exit(0);
    }

    const row = await openDecision(admin, { sessionId, workspaceId, question, detail: detail || undefined, category });
    console.log(`Decision raised (${row.id}). Waiting for the founder in the cockpit…`);
    const result = await pollApproval(admin, sessionId, row.id);
    if (result === "approved") { console.log("APPROVED. Proceed."); process.exit(0); }
    if (result === "denied") { console.log("DECLINED — stop and reply in the transcript."); process.exit(1); }
    const asked = await getApproval(admin, row.id);
    console.log(`FOUNDER ASKED: ${asked?.question_text ?? "(no question)"} — answer in your reply, then re-run decide if still needed.`);
    process.exit(2);
  }

  // ── legacy plan subcommands (back-compat) ────────────────────────────────
  if (cmd === "close") { await setActivePlan(admin, sessionId, null); console.log("PLAN CLOSED."); process.exit(0); }
  if (cmd === "status") {
    const plan = await getActivePlan(admin, sessionId);
    console.log(plan ? `Open plan ${plan.id}: ${plan.preview}` : "No open plan.");
    process.exit(0);
  }
  if (cmd === "open") {
    const title = (process.argv[3] || "").trim();
    const steps = process.argv.slice(4).map((s) => s.trim()).filter(Boolean);
    if (!title) { console.error('god-mode-plan open: a title is required.'); process.exit(1); }
    if (!(await isSessionArmed(admin, sessionId))) { console.error("god-mode-plan: session is not armed."); process.exit(1); }
    const plan = await openPlan(admin, { sessionId, workspaceId, title, steps });
    console.log(`Plan opened (${plan.id}). Waiting for approval…`);
    const result = await pollApproval(admin, sessionId, plan.id);
    if (result === "approved") { await setActivePlan(admin, sessionId, plan.id); console.log("PLAN APPROVED."); process.exit(0); }
    if (result === "denied") { console.log("PLAN DENIED."); process.exit(1); }
    const asked = await getApproval(admin, plan.id);
    console.log(`FOUNDER ASKED: ${asked?.question_text ?? "(no question)"}`);
    process.exit(2);
  }

  console.error(`god-mode-plan: unknown command "${cmd}". Use decide | open | close | status.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`god-mode-plan error: ${errText(err)}`);
  process.exit(1);
});
