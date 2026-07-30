/**
 * Watches Pia's plan job until it leaves the running/queued state (she parks at
 * needs_approval with the proposed spec tree in pending_actions), then exits so the
 * session is re-invoked to review. Uses node timers (no shell sleep). Background runner.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const JOB_ID = process.env.PLAN_JOB_ID || "e3223795-070e-477b-b4b7-44a663ac27f7";
const TERMINAL = new Set(["needs_approval", "needs_input", "completed", "failed", "cancelled", "error"]);
const POLL_MS = 30_000;
const MAX_POLLS = 70; // ~35 min ceiling

async function main() {
  const admin = createAdminClient();
  let last = "";
  for (let i = 1; i <= MAX_POLLS; i++) {
    const { data, error } = await admin
      .from("agent_jobs")
      .select("id,status,kind,spec_slug,updated_at")
      .eq("id", JOB_ID)
      .maybeSingle();
    if (error) { console.log(`[watch] poll ${i} err: ${error.message}`); }
    else if (!data) { console.log(`[watch] poll ${i}: job ${JOB_ID} not found`); }
    else {
      const s = String(data.status);
      if (s !== last) { console.log(`[watch] poll ${i}: status=${s} (updated ${data.updated_at})`); last = s; }
      if (TERMINAL.has(s)) { console.log(`[watch] TERMINAL status=${s} — Pia's plan is ready to review.`); return; }
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  console.log(`[watch] timed out after ~${(MAX_POLLS * POLL_MS) / 60000}min — last status=${last}. Pia may still be running.`);
}
main().then(() => process.exit(0)).catch((e) => { console.error("[watch] fatal:", e); process.exit(1); });
