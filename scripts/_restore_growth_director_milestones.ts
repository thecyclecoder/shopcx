/**
 * One-off RESTORE: reconstruct growth-director's goal_milestones (never created — the goal was proposed with a
 * prose "Suggested milestone arc" instead of a `## Decomposition` block, so upsertGoal seeded 0 milestones;
 * Pia then authored M1–M6 specs whose `milestone` handles resolved to nothing, and the author-time gate
 * silently left milestone_id NULL because the goal had zero milestones). We recreate the 6 milestones from
 * the goal's own arc + the specs' parent labels, then re-link each member spec via the goals SDK.
 *
 * DRY-RUN by default; APPLY=1 to write. SDK-only (upsertGoal + attachSpecToMilestone).
 */
import "./_bootstrap";
import { getGoal, upsertGoal, attachSpecToMilestone, listMilestones } from "../src/lib/goals-table";
import { createAdminClient } from "../src/lib/supabase/admin";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const APPLY = process.env.APPLY === "1";

// The 6-milestone arc (titles match the spec parent labels so future "M{n}"/title handle resolution works).
const MILESTONES: { position: number; title: string; body: string }[] = [
  { position: 1, title: "M1 — Director core", body: "Stand up the Growth Director agent on the existing director rails; define the leash; register the blended CAC↔LTV objective." },
  { position: 2, title: "M2 — Decide/allocation layer", body: "Surface the blended CAC↔LTV objective + the allocation brain (where the next dollar/effort goes across Meta vs storefront)." },
  { position: 3, title: "M3 — Spend rails", body: "A true ad-DOLLAR budget ceiling + a guardrail-hit escalation surface." },
  { position: 4, title: "M4 — Adopt + verify existing tools", body: "Flip the Meta iteration engine to execute under the leash; fix + adopt the storefront optimizer (delivery-verification); adopt the creative makers + the ROAS aggregator." },
  { position: 5, title: "M5 — Performance→creative loop", body: "Close the performance→creative loop: winners feed more creative; customer voice → ad angles; own-winner ↔ landing-page test." },
  { position: 6, title: "M6 — Live + autonomous, escalate-only-super-serious", body: "Go live + autonomous (Ada's bar), escalate only the genuinely high-stakes → ship & fold." },
];

// Member spec → milestone position, matched by the spec's parent label prefix. Only specs whose milestone_id
// is currently NULL are touched (never re-point a spec already linked to another goal's milestone).
const LABEL_TO_POS: { prefix: string; pos: number }[] = [
  { prefix: "M1 — Director core", pos: 1 },
  { prefix: "M2 — Decide/allocation layer", pos: 2 },
  { prefix: "M3 — Spend rails", pos: 3 },
  { prefix: "M4 — Adopt + verify existing tools", pos: 4 },
  { prefix: "M5 — Performance→creative loop", pos: 5 },
  { prefix: "M6 — Live + autonomous", pos: 6 },
];

(async () => {
  const admin = createAdminClient();
  const goal = await getGoal(WS, "growth-director");
  if (!goal) throw new Error("growth-director goal not found");
  console.log(`goal growth-director: status=${goal.status} is_parent=${goal.is_parent} milestones=${goal.milestones.length}`);

  // Identify member specs (parent label prefix match, milestone_id NULL).
  const { data: specs } = await admin
    .from("specs")
    .select("id,slug,status,milestone_id,parent")
    .eq("workspace_id", WS)
    .is("milestone_id", null);
  const members: { id: string; slug: string; status: string; pos: number }[] = [];
  for (const s of (specs || []) as { id: string; slug: string; status: string; milestone_id: string | null; parent: string | null }[]) {
    const p = (s.parent || "").trim();
    const hit = LABEL_TO_POS.find((l) => p.startsWith(l.prefix));
    if (hit) members.push({ id: s.id, slug: s.slug, status: s.status, pos: hit.pos });
  }
  members.sort((a, b) => a.pos - b.pos || a.slug.localeCompare(b.slug));
  console.log(`\nmember specs to link (${members.length}):`);
  for (const m of members) console.log(`  M${m.pos} ← ${m.slug} (status=${m.status})`);

  const usedPositions = new Set(members.map((m) => m.pos));
  const milestonesToCreate = MILESTONES.filter((m) => usedPositions.has(m.position));
  console.log(`\nmilestones to create (only positions with ≥1 member spec): ${milestonesToCreate.map((m) => `M${m.position}`).join(", ")}`);

  if (!APPLY) {
    console.log("\n[DRY-RUN] no writes. Set APPLY=1 to execute.");
    return;
  }

  // 1) Create the milestones via upsertGoal — pass the EXISTING goal row fields so nothing is clobbered
  //    (preserve title/body/outcome/owner/is_parent/status). REPLACE-by-position over a 0-milestone goal = pure inserts.
  const res = await upsertGoal(
    WS,
    {
      slug: goal.slug,
      title: goal.title,
      body: goal.body,
      outcome: goal.outcome,
      success_metric: goal.success_metric,
      owner: goal.owner,
      proposer_function: goal.proposer_function,
      parent_goal_id: goal.parent_goal_id,
      is_parent: goal.is_parent, // keep PARENT flag
      status: goal.status, // keep greenlit (parent stays active, awaiting sub-goals)
    },
    milestonesToCreate,
  );
  console.log("\nupsertGoal milestone_ids:", JSON.stringify(res.milestone_ids));

  // 2) Re-link each member spec to its milestone id (by position).
  const created = await listMilestones(res.goal_id);
  const idByPos = new Map(created.map((m) => [m.position, m.id]));
  for (const m of members) {
    const mid = idByPos.get(m.pos);
    if (!mid) { console.warn(`  ! no milestone id for M${m.pos} (${m.slug})`); continue; }
    await attachSpecToMilestone(m.id, mid);
    console.log(`  linked ${m.slug} → M${m.pos} (${mid})`);
  }
  console.log("\nDONE.");
})().catch((e) => { console.error(e); process.exit(1); });
