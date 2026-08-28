/** Dump the 13 decision-surface cards in full, so claims can be read rather than pattern-matched. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();
  const { data, error } = await a.from("dashboard_notifications")
    .select("id,title,body,created_at,type,metadata")
    .eq("workspace_id", WS).eq("dismissed", false).eq("type", "agent_approval_request")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);

  for (const n of data ?? []) {
    const md = (n.metadata ?? {}) as Record<string, unknown>;
    console.log(`\n${"═".repeat(100)}`);
    console.log(`[${String(n.created_at).slice(0, 16)}] ${md.escalation_kind ?? "—"}`);
    console.log(`TITLE: ${n.title}`);
    console.log(`BODY (${String(n.body ?? "").length} chars):`);
    console.log(String(n.body ?? "(empty)").slice(0, 1100));
    const keys = Object.keys(md).filter((k) => !/^(deep_link|dedupe_key)$/.test(k));
    console.log(`META: ${keys.map((k) => `${k}=${String(md[k]).slice(0, 60)}`).join(" · ").slice(0, 400)}`);
  }
  console.log(`\n\ntotal: ${(data ?? []).length}`);
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
