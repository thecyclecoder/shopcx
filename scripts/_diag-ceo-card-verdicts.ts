/** Read-only: for each open CEO card, WHY is it still here? correctly-kept vs should-have-cleared. */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

const admin = createAdminClient();

async function main() {
  const { data, error } = await admin
    .from("dashboard_notifications")
    .select("id, created_at, title, metadata")
    .eq("type", "agent_approval_request")
    .eq("dismissed", false)
    .limit(2000);
  if (error) throw error;

  const cards = (data ?? []).filter((r) => {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    return (m["routed_to_function"] ?? "ceo") === "ceo";
  });

  for (const c of cards) {
    const m = (c.metadata ?? {}) as Record<string, unknown>;
    const kind = (m["escalation_kind"] as string) ?? "(none)";
    const key = (m["dedupe_key"] as string) ?? "(no dedupe_key)";
    const slug = (m["spec_slug"] as string) ?? null;
    const jobId = (m["agent_job_id"] as string) ?? (m["job_id"] as string) ?? null;
    const ticketId = (m["ticket_id"] as string) ?? null;
    const ageH = ((Date.now() - new Date(c.created_at).getTime()) / 3_600_000).toFixed(0);

    let jobStatus = "—";
    if (jobId) {
      const { data: j } = await admin.from("agent_jobs").select("status").eq("id", jobId).maybeSingle();
      jobStatus = j ? String((j as { status: string }).status) : "GONE";
    }
    let specStatus = "—";
    let landedAfter = "—";
    if (slug) {
      const { data: s } = await admin.from("specs").select("status").eq("slug", slug).maybeSingle();
      specStatus = s ? String((s as { status: string | null }).status ?? "(null)") : "NO SPEC ROW";
      const { data: landed } = await admin
        .from("agent_jobs")
        .select("created_at")
        .eq("spec_slug", slug)
        .in("status", ["completed", "merged"])
        .order("created_at", { ascending: false })
        .limit(1);
      const t = (landed ?? [])[0] as { created_at: string } | undefined;
      landedAfter = t ? (new Date(t.created_at) > new Date(c.created_at) ? "YES" : "no (before card)") : "none";
    }
    let ticketStatus = "—";
    if (ticketId) {
      const { data: t } = await admin.from("tickets").select("status").eq("id", ticketId).maybeSingle();
      ticketStatus = t ? String((t as { status: string }).status) : "GONE";
    }

    console.log(
      `\n${key}\n  kind=${kind}  age=${ageH}h\n  spec=${slug ?? "—"} (${specStatus})  job=${jobStatus}  landed_after_card=${landedAfter}  ticket=${ticketStatus}\n  "${String(c.title).slice(0, 80)}"`,
    );
  }
  console.log(`\n${cards.length} CEO cards`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
