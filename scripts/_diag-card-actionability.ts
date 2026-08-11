/** Read-only: which open CEO cards carry an ACTION the founder can actually take? */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

const admin = createAdminClient();

async function main() {
  const { data, error } = await admin
    .from("dashboard_notifications")
    .select("id, created_at, title, body, metadata")
    .eq("type", "agent_approval_request")
    .eq("dismissed", false)
    .limit(2000);
  if (error) throw error;

  const cards = (data ?? []).filter((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    return (m["routed_to_function"] ?? "ceo") === "ceo";
  });

  let actionable = 0;
  for (const c of cards) {
    const m = (c.metadata ?? {}) as Record<string, unknown>;
    const jobId = (m["agent_job_id"] as string) ?? (m["job_id"] as string) ?? null;
    let pending: Array<{ id?: string; label?: string; status?: string }> = [];
    if (jobId) {
      const { data: job, error: jErr } = await admin
        .from("agent_jobs")
        .select("pending_actions")
        .eq("id", jobId)
        .maybeSingle();
      if (jErr) throw jErr; // never let a failed read look like "no actions"
      const raw = (job as { pending_actions?: unknown } | null)?.pending_actions;
      if (Array.isArray(raw)) pending = raw as typeof pending;
    }
    const open = pending.filter((p) => (p.status ?? "pending") === "pending");
    if (open.length) actionable++;
    const bodyLen = (c.body ?? "").length;
    const titleIsUuid = /^[^:]*:\s*[0-9a-f]{8}-[0-9a-f]{4}-/i.test(String(c.title ?? ""));
    console.log(
      `\n${String(c.title).slice(0, 70)}\n  kind=${m["escalation_kind"] ?? "(routed approval)"}  job=${jobId?.slice(0, 8) ?? "—"}\n  pending_actions=${open.length}  body_chars=${bodyLen}  uuid_title=${titleIsUuid}`,
    );
  }
  console.log(`\n${cards.length} CEO cards · ${actionable} carry a pending action · ${cards.length - actionable} are read-only notices`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
