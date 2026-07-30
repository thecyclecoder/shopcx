import { loadEnv } from "./_bootstrap";
loadEnv();
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const { data: jobs } = await admin
    .from("agent_jobs")
    .select("id, kind, status, spec_slug, pending_actions, session_note, session_checklist, log_tail, pr_url, updated_at, needs_attention_class")
    .eq("workspace_id", WS)
    .eq("spec_slug", "spec-timecard-ledger-and-sdk")
    .order("created_at", { ascending: false })
    .limit(3);
  for (const j of (jobs ?? []) as Record<string, unknown>[]) {
    console.log(`\n=== ${j.kind} [${j.status}] id=${String(j.id).slice(0,8)} class=${j.needs_attention_class ?? ""} ===`);
    console.log(`pr_url: ${j.pr_url ?? "-"}   updated_at: ${j.updated_at}`);
    console.log(`session_note: ${j.session_note ?? "-"}`);
    const chk = (j.session_checklist ?? []) as { step: string; status: string }[];
    if (chk.length) {
      console.log("checklist:");
      for (const c of chk) console.log(`   [${c.status}] ${c.step}`);
    }
    const pa = (j.pending_actions ?? []) as Record<string, unknown>[];
    if (pa.length) {
      console.log("PENDING ACTIONS:");
      for (const a of pa) {
        console.log(`   • id=${a.id} type=${a.type} status=${a.status}`);
        console.log(`     ${String(a.summary ?? a.title ?? a.preview ?? "").slice(0, 500)}`);
        if (a.command) console.log(`     command: ${String(a.command).slice(0, 300)}`);
      }
    }
    const tail = String(j.log_tail ?? "").split("\n").slice(-12).join("\n   ");
    if (tail.trim()) console.log(`log_tail:\n   ${tail}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
