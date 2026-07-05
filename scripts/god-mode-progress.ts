/**
 * god-mode-progress — the box's live-checklist + confirmation primitive for the
 * god-mode lane (docs/brain/lifecycles/god-mode.md).
 *
 * The founder should never stare at a blank screen wondering if a response is
 * coming. The MOMENT the box starts working on a message it emits a plain-language
 * checklist and checks each item off as it goes — the way the build box shows its
 * phases. It also posts short confirmation lines ("Done — 4 stale approvals removed").
 *
 * This runs INSIDE a god-mode turn (GOD_MODE_SESSION_ID is in the env) and writes
 * directly to the transcript via the SDK. It's an ordinary non-catastrophic call,
 * so the permission gate allows it.
 *
 * Usage:
 *   npx tsx scripts/god-mode-progress.ts start "What I'm doing" "Step one" "Step two" "Step three"
 *   npx tsx scripts/god-mode-progress.ts step 1        # mark step 1 done, advance
 *   npx tsx scripts/god-mode-progress.ts done          # mark all steps done
 *   npx tsx scripts/god-mode-progress.ts note "Done — 4 stale approvals removed."
 *
 * Keep titles/steps/notes free of the shell metacharacters ; & | ` $ < > .
 */
import { createAdminClient } from "./_bootstrap";
import { startChecklist, checklistStep, finishChecklist, appendNote } from "../src/lib/god-mode";

async function main() {
  const sessionId = process.env.GOD_MODE_SESSION_ID;
  if (!sessionId) {
    console.error("god-mode-progress: GOD_MODE_SESSION_ID not set (run inside a god-mode session).");
    process.exit(1);
  }
  const admin = createAdminClient();
  const cmd = (process.argv[2] || "").toLowerCase();

  if (cmd === "start") {
    const title = (process.argv[3] || "").trim();
    const steps = process.argv.slice(4).map((s) => s.trim()).filter(Boolean);
    if (!title || steps.length === 0) {
      console.error('god-mode-progress start: need a title and at least one step, e.g. start "Triaging your approvals" "Researching them" "Deciding".');
      process.exit(1);
    }
    await startChecklist(admin, sessionId, { title, steps });
    console.log(`checklist started (${steps.length} steps).`);
    process.exit(0);
  }

  if (cmd === "step") {
    const n = parseInt(process.argv[3] || "", 10);
    if (!Number.isFinite(n) || n < 1) {
      console.error("god-mode-progress step: pass the 1-based step number, e.g. step 2.");
      process.exit(1);
    }
    await checklistStep(admin, sessionId, n);
    console.log(`step ${n} checked.`);
    process.exit(0);
  }

  if (cmd === "done") {
    await finishChecklist(admin, sessionId);
    console.log("checklist complete.");
    process.exit(0);
  }

  if (cmd === "note") {
    const text = (process.argv[3] || "").trim();
    if (!text) {
      console.error('god-mode-progress note: pass the confirmation text, e.g. note "Done — 4 stale approvals removed."');
      process.exit(1);
    }
    await appendNote(admin, sessionId, text);
    console.log("note posted.");
    process.exit(0);
  }

  console.error(`god-mode-progress: unknown command "${cmd}". Use start | step | done | note.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`god-mode-progress error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
