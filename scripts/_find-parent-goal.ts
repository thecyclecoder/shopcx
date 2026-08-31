/** Find the right owner + parent for the arming-feeds spec. READ-ONLY. */
import { createAdminClient } from "./_bootstrap";
const WS = process.env.WORKSPACE_ID ?? "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const a = createAdminClient();
  const { data: goals, error } = await a.from("goals")
    .select("*").eq("workspace_id", WS);
  if (error) throw new Error(`goals: ${error.message}`);
  console.log("goals:");
  for (const g of goals ?? []) {
    const fields = Object.entries(g).filter(([k, v]) => /owner|status|function/i.test(k) && v != null).map(([k, v]) => `${k}=${String(v)}`).join(" ");
    console.log(`  ${String(g.slug).padEnd(52)} ${fields}`);
  }

  const media = (goals ?? []).filter((g) => /media|buyer|growth|acquisition|ad/i.test(String(g.slug)));
  for (const g of media) {
    const { data: ms } = await a.from("goal_milestones")
      .select("id,slug,title,position,status").eq("goal_id", g.id).order("position");
    console.log(`\nmilestones for ${g.slug}:`);
    for (const m of ms ?? []) console.log(`  ${String(m.position).padStart(2)} ${String(m.slug ?? m.title).slice(0, 60)} [${m.status}]`);
  }

  // A recent growth spec, for the owner/parent conventions actually in use.
  const { data: specs } = await a.from("specs")
    .select("slug,owner,parent,parent_kind,parent_ref,priority").eq("workspace_id", WS)
    .eq("owner", "growth").order("created_at", { ascending: false }).limit(5);
  console.log("\nrecent growth specs (owner/parent conventions):");
  for (const s of specs ?? []) {
    console.log(`  ${String(s.slug).slice(0, 52).padEnd(52)} parent=${s.parent} kind=${s.parent_kind ?? "—"} ref=${s.parent_ref ?? "—"}`);
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e instanceof Error ? e.message : JSON.stringify(e));
  process.exit(1);
});
