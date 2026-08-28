/** Are the 609 open fraud_alert notifications pointing at ALREADY-RESOLVED cases? READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();

  const notifs: Array<Record<string, unknown>> = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await a.from("dashboard_notifications")
      .select("id,title,metadata,created_at").eq("workspace_id", WS)
      .eq("type", "fraud_alert").eq("dismissed", false).range(off, off + 999);
    if (error) throw new Error(error.message);
    notifs.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const ids = [...new Set(notifs.map((n) => String((n.metadata as Record<string, unknown>)?.entity_id ?? "")).filter(Boolean))];
  console.log(`open fraud_alert notifications: ${notifs.length} · distinct case ids: ${ids.length}`);

  const cases: Array<Record<string, unknown>> = [];
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error } = await a.from("fraud_cases")
      .select("id,status,severity,reviewed_at,resolution").eq("workspace_id", WS).in("id", ids.slice(i, i + 100));
    if (error) throw new Error(`fraud_cases: ${error.message}`);
    cases.push(...(data ?? []));
  }
  const byId = new Map(cases.map((c) => [String(c.id), c]));
  console.log(`resolved to a case: ${cases.length}/${ids.length}`);

  const TERMINAL = new Set(["dismissed", "confirmed_fraud", "resolved", "closed"]);
  const byStatus: Record<string, number> = {};
  let terminal = 0, open = 0, unresolvable = 0;
  for (const n of notifs) {
    const c = byId.get(String((n.metadata as Record<string, unknown>)?.entity_id ?? ""));
    if (!c) { unresolvable += 1; continue; }
    const st = String(c.status);
    byStatus[st] = (byStatus[st] ?? 0) + 1;
    if (TERMINAL.has(st)) terminal += 1; else open += 1;
  }
  console.log(`\nlinked case status: ${JSON.stringify(byStatus)}`);
  console.log(`  TERMINAL (safe to retire):  ${terminal}`);
  console.log(`  still OPEN (must keep):     ${open}`);
  console.log(`  unresolvable (must keep):   ${unresolvable}`);

  // Every status the table uses, so the terminal set is grounded rather than guessed.
  const { data: allCases } = await a.from("fraud_cases").select("status").eq("workspace_id", WS);
  const allStatus: Record<string, number> = {};
  for (const c of allCases ?? []) allStatus[String(c.status)] = (allStatus[String(c.status)] ?? 0) + 1;
  console.log(`\nALL fraud_cases statuses in the workspace: ${JSON.stringify(allStatus)}`);
  console.log(`  ⇒ terminal set must cover exactly these, and nothing more.`);

  // Is the queue current? Newest case vs newest review.
  const { data: newest } = await a.from("fraud_cases")
    .select("created_at,reviewed_at,status").eq("workspace_id", WS)
    .order("created_at", { ascending: false }).limit(3);
  console.log(`\nnewest cases:`);
  for (const c of newest ?? []) console.log(`  created ${String(c.created_at).slice(0, 16)} status=${c.status} reviewed=${String(c.reviewed_at ?? "—").slice(0, 16)}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
