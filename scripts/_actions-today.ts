/** Every iteration_action in the last 36h — confirm what moved and who moved it. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const admin = createAdminClient();
  const since = new Date(Date.now() - 36 * 3600_000).toISOString();
  const { data, error } = await admin.from("iteration_actions")
    .select("created_at,level,object_id,action_type,label,status,before_budget_cents,after_budget_cents,rationale")
    .eq("workspace_id", WS).gte("created_at", since).order("created_at");
  if (error) throw new Error(error.message);
  console.log(`iteration_actions since ${since.slice(0, 16)}: ${(data ?? []).length}`);
  for (const a of data ?? []) {
    const f = a.before_budget_cents != null ? "$" + (Number(a.before_budget_cents) / 100).toFixed(0) : "—";
    const t = a.after_budget_cents != null ? "$" + (Number(a.after_budget_cents) / 100).toFixed(0) : "—";
    console.log(`  ${String(a.created_at).slice(0, 16)} ${String(a.action_type).padEnd(11)} ${String(a.object_id).slice(-10)} ${f}→${t} [${a.status}]`);
    console.log(`     ${String(a.rationale ?? "").slice(0, 120)}`);
  }

  const { data: acts } = await admin.from("director_activity")
    .select("created_at,action_kind,reason").eq("workspace_id", WS)
    .gte("created_at", since).order("created_at", { ascending: false }).limit(12);
  console.log(`\ndirector_activity since then: ${(acts ?? []).length}`);
  for (const a of acts ?? []) {
    console.log(`  ${String(a.created_at).slice(0, 16)} ${String(a.action_kind).padEnd(42)} ${String(a.reason ?? "").slice(0, 80)}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
