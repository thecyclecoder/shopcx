// backfill-goals-from-markdown — db-driven-specs M5 / [[goals-milestones-tables-and-backfill]] Phase 3.
//
// One-time backfill: read every `docs/brain/goals/*.md`, run the existing brain-roadmap `parseGoal`
// ONE LAST TIME, and INSERT/UPDATE matching rows into `public.goals` + `public.goal_milestones`. Per
// workspace. Then a SECOND PASS resolves `goals.parent_goal_id` from the "Reports to [[<slug>]]" wikilink
// shape, and a THIRD PASS attaches `public.specs.milestone_id` by matching the spec's `parent` text
// against the goal's milestones.
//
//   Dry run (default):  npx tsx scripts/backfill-goals-from-markdown.ts
//   Apply:              npx tsx scripts/backfill-goals-from-markdown.ts --apply
//
// Idempotent + resumable: UPSERTs `goals` by `(workspace_id, slug)`; milestone REPLACE is by
// `(goal_id, position)` (the same id-by-position rule [[../libraries/specs-table]] `upsertSpec` uses) —
// so re-running on stable state is a no-op (only `updated_at` bumps) and a [[../tables/specs]]
// `milestone_id` FK is never silently unattached on a retitle.
//
// After --apply: walks every `goals` row and flags any whose status doesn't match the markdown parse for
// human review — does NOT silently overwrite. Out of scope: deleting `docs/brain/goals/*.md` (the .md
// stays authoritative until [[../specs/goal-readers-from-db-retire-parsegoal]] retires the parser);
// the CEO greenlight UI ([[../specs/goal-greenlight-button-and-author-writes-db]]); fold
// ([[../specs/goal-fold-from-db-row]]).
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { createAdminClient } from "./_bootstrap";
import { parseGoal, parseSpec, type GoalCard, type SpecCard } from "../src/lib/brain-roadmap";
import {
  upsertGoal,
  setGoalStatus,
  attachSpecToMilestone,
  type GoalRowStatus,
  type MilestoneRowStatus,
  type GoalMilestoneInput,
} from "../src/lib/goals-table";

const APPLY = process.argv.includes("--apply");
const GOALS_DIR = resolve(__dirname, "../docs/brain/goals");
const SPECS_DIR = resolve(__dirname, "../docs/brain/specs");

interface Workspace {
  id: string;
  name: string | null;
}

interface ParsedGoal {
  slug: string;
  raw: string;
  card: GoalCard;
}

/** Pick the goal's parent slug from a "Reports to [[<slug>]]" or "Parent: ... [[<slug>]]" line. The
 *  markdown is inconsistent (Target paragraph for db-driven-specs, an Ownership line for others) — try
 *  both shapes; first hit wins. */
function extractParentGoalSlug(raw: string): string | null {
  const reportsTo = raw.match(/Reports to:?\s*\[\[([^\]|]+)/i);
  if (reportsTo) return reportsTo[1].trim().replace(/^.*\//, "").replace(/\.md$/, "");
  const parent = raw.match(/Parent:[^\n]*?\[\[([^\]|]+)/i);
  if (parent) return parent[1].trim().replace(/^.*\//, "").replace(/\.md$/, "");
  return null;
}

/** Parse a spec's `**Parent:**` header line into `{ goalSlug, milestoneKey }`. The markdown shape is
 *  `**Parent:** [[../goals/<slug>]] M{N} — <title>` (or `· M{N}` separator, or just the goal link).
 *  Returns `null` when the parent doesn't point at a goal at all (function-mandate / sibling spec). */
function extractSpecParent(raw: string): { goalSlug: string; milestoneKey: string | null } | null {
  const line = raw.split("\n").find((l) => /^\*\*Parent:\*\*/.test(l));
  if (!line) return null;
  const goalMatch = line.match(/\[\[\.\.\/goals\/([^\]|]+?)(?:\.md)?(?:\|[^\]]+)?\]\]/);
  if (!goalMatch) return null;
  const goalSlug = goalMatch[1];
  const rest = line.slice(line.indexOf(goalMatch[0]) + goalMatch[0].length);
  // Try M{N} after the link first — the canonical shape.
  const mN = rest.match(/\bM(\d+)\b/);
  if (mN) return { goalSlug, milestoneKey: `M${mN[1]}` };
  // Otherwise fall back to the trailing title text (after a separator).
  const tail = rest.replace(/^[\s·•—–-]+/, "").split(/\s—\s|\s-\s|·/)[0]?.trim();
  if (tail) return { goalSlug, milestoneKey: tail };
  return { goalSlug, milestoneKey: null };
}

/** Match a spec's parsed `milestoneKey` against a goal's milestones. Returns the milestone row's
 *  database position, or null when no unambiguous match. */
function matchMilestone(
  goalCard: GoalCard,
  milestoneKey: string | null,
): number | null {
  if (!milestoneKey) return null;
  // Prefer the M{N} prefix match — that's the canonical anchor.
  if (/^M\d+$/i.test(milestoneKey)) {
    const idx = goalCard.milestones.findIndex((m) => m.id.toLowerCase() === milestoneKey.toLowerCase());
    return idx >= 0 ? idx + 1 : null;
  }
  // Otherwise prefix-match on title (case-insensitive).
  const lower = milestoneKey.toLowerCase();
  const matches = goalCard.milestones
    .map((m, i) => ({ i, name: m.name.toLowerCase() }))
    .filter((m) => m.name.startsWith(lower) || lower.startsWith(m.name));
  return matches.length === 1 ? matches[0].i + 1 : null;
}

/** Goal status from a parsed GoalCard — the markdown `**Status:**` line via parseGoal's deriveGoalStatus.
 *  The DB column accepts `folded` too, but the markdown parser never yields it. */
function statusFromCard(card: GoalCard): GoalRowStatus {
  return card.status as GoalRowStatus;
}

/** Milestone status by walking the goal card's milestones — the parser sets each milestone's `status` to
 *  the emoji on the bullet (defaults `planned`). Map `shipped` → DB `complete`. */
function milestoneStatusFromCard(emoji: string | undefined): MilestoneRowStatus {
  if (emoji === "shipped") return "complete";
  if (emoji === "in_progress") return "in_progress";
  return "planned";
}

async function main() {
  const goalFiles = readdirSync(GOALS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  console.log(`Parsing ${goalFiles.length} goal file(s) from ${GOALS_DIR}`);

  // Parse every spec ONCE — feeds parseGoal (for the rollup percentage) and is reused for the
  // milestone_id attachment pass.
  const specFiles = readdirSync(SPECS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  const specRaws = new Map<string, string>();
  const specCards = new Map<string, SpecCard>();
  for (const f of specFiles) {
    const slug = f.replace(/\.md$/, "");
    const raw = readFileSync(resolve(SPECS_DIR, f), "utf8");
    specRaws.set(slug, raw);
    specCards.set(slug, parseSpec(slug, raw));
  }
  const specCardsArr = [...specCards.values()];

  const parsed = new Map<string, ParsedGoal>();
  for (const f of goalFiles) {
    const slug = f.replace(/\.md$/, "");
    const raw = readFileSync(resolve(GOALS_DIR, f), "utf8");
    const card = parseGoal(slug, raw, specCardsArr);
    parsed.set(slug, { slug, raw, card });
  }

  const admin = createAdminClient();
  const { data: workspacesData, error: wsErr } = await admin.from("workspaces").select("id, name");
  if (wsErr) throw wsErr;
  const workspaces = (workspacesData ?? []) as Workspace[];
  console.log(`Found ${workspaces.length} workspace(s)`);

  let totalGoalsUpserted = 0;
  let totalMilestonesPlaced = 0;
  let totalSpecsAttached = 0;
  const statusMismatches: { workspace: string; slug: string; expected: string; got: string }[] = [];

  for (const ws of workspaces) {
    console.log(`\n--- workspace ${ws.id} (${ws.name ?? ""}) ---`);

    // PASS 1: UPSERT every goal + its milestones (without parent_goal_id — that needs every goal's id
    // in this workspace, which only the second pass has).
    const goalIdBySlug = new Map<string, string>();
    for (const { slug, card, raw } of parsed.values()) {
      const milestones: GoalMilestoneInput[] = card.milestones.map((m, i) => ({
        position: i + 1,
        title: m.id ? `${m.id} — ${m.name}` : m.name,
        body: null,
        status: milestoneStatusFromCard(m.status as unknown as string),
      }));
      const proposedBy = card.proposedBy ?? null;
      // pull the H1+meta body as a single text — the full markdown so DB consumers can render without re-reading.
      const body = raw;
      const desiredStatus = statusFromCard(card);

      console.log(
        `  ${slug}: ${milestones.length} milestones, status=${desiredStatus}, owner=${card.owner ?? "?"}${proposedBy ? ` proposed-by=${proposedBy}` : ""}`,
      );

      if (!APPLY) continue;
      totalGoalsUpserted++;
      totalMilestonesPlaced += milestones.length;
      const { goal_id } = await upsertGoal(
        ws.id,
        {
          slug,
          title: card.title,
          body,
          outcome: card.outcome || null,
          success_metric: card.successMetric || null,
          owner: card.owner ?? "",
          proposer_function: proposedBy,
          parent_goal_id: null, // resolved in pass 2
          status: desiredStatus,
        },
        milestones,
      );
      goalIdBySlug.set(slug, goal_id);
    }

    if (!APPLY) continue;

    // PASS 2: resolve goals.parent_goal_id by walking the "Reports to [[<slug>]]" / "Parent: [[<slug>]]"
    // wikilink shape. A second SQL pass keeps the first pass strictly position-based and avoids ordering
    // pitfalls (a child goal may parse before its parent).
    for (const { slug, raw } of parsed.values()) {
      const parentSlug = extractParentGoalSlug(raw);
      if (!parentSlug) continue;
      const myId = goalIdBySlug.get(slug);
      const parentId = goalIdBySlug.get(parentSlug);
      if (!myId || !parentId) {
        console.log(`  parent-link skipped: ${slug} → ${parentSlug} (one side missing)`);
        continue;
      }
      const { error: pErr } = await admin
        .from("goals")
        .update({ parent_goal_id: parentId, updated_at: new Date().toISOString() })
        .eq("id", myId);
      if (pErr) {
        console.warn(`  parent-link rejected: ${slug} → ${parentSlug} (${pErr.message})`);
      } else {
        console.log(`  ${slug} → parent ${parentSlug}`);
      }
    }

    // PASS 3: attach specs.milestone_id by matching the spec's `**Parent:**` text. We need every
    // milestone's id keyed by (goal_id, position); fetch them ONCE per workspace.
    const { data: allMilestones, error: mErr } = await admin
      .from("goal_milestones")
      .select("id, goal_id, position");
    if (mErr) throw mErr;
    const milestoneId = new Map<string, string>();
    for (const m of (allMilestones ?? []) as { id: string; goal_id: string; position: number }[]) {
      milestoneId.set(`${m.goal_id}:${m.position}`, m.id);
    }

    // Get every spec row in this workspace ONCE — match against parsed markdown's Parent header.
    const { data: dbSpecs, error: sErr } = await admin
      .from("specs")
      .select("id, slug")
      .eq("workspace_id", ws.id);
    if (sErr) throw sErr;
    const specRowBySlug = new Map<string, string>();
    for (const s of (dbSpecs ?? []) as { id: string; slug: string }[]) specRowBySlug.set(s.slug, s.id);

    for (const [specSlug, raw] of specRaws.entries()) {
      const specRowId = specRowBySlug.get(specSlug);
      if (!specRowId) continue; // spec not in DB yet (only the backfill seeds it — spec-body M1)
      const parent = extractSpecParent(raw);
      if (!parent) continue;
      const goalId = goalIdBySlug.get(parent.goalSlug);
      if (!goalId) continue;
      const parsedGoal = parsed.get(parent.goalSlug);
      if (!parsedGoal) continue;
      const position = matchMilestone(parsedGoal.card, parent.milestoneKey);
      if (!position) continue;
      const mId = milestoneId.get(`${goalId}:${position}`);
      if (!mId) continue;
      await attachSpecToMilestone(specRowId, mId);
      totalSpecsAttached++;
    }

    // VERIFY: every goal row's status should match the markdown parse. The rollup may have advanced
    // greenlit → complete on its own; flag the unexpected divergence (proposed flipped to anything,
    // unexpected backslide) rather than overwriting.
    const { data: persisted, error: vErr } = await admin
      .from("goals")
      .select("slug, status")
      .eq("workspace_id", ws.id);
    if (vErr) throw vErr;
    for (const { slug, status } of (persisted ?? []) as { slug: string; status: GoalRowStatus }[]) {
      const expected = parsed.get(slug)?.card.status;
      if (!expected) continue;
      // The rollup may legitimately advance greenlit → complete; tolerate that one direction.
      if (status === expected) continue;
      if (expected === "greenlit" && status === "complete") continue;
      statusMismatches.push({ workspace: ws.id, slug, expected, got: status });
    }
  }

  console.log(`\n${APPLY ? "APPLIED" : "DRY-RUN"} — goals upserted=${totalGoalsUpserted}, milestones placed=${totalMilestonesPlaced}, specs attached=${totalSpecsAttached}`);
  if (statusMismatches.length) {
    console.log(`\n⚠ ${statusMismatches.length} goal status mismatch(es) for human review:`);
    for (const m of statusMismatches) console.log(`  ${m.workspace} ${m.slug}: expected=${m.expected} got=${m.got}`);
  }
  // The unused-imports linter wants every imported name referenced once; setGoalStatus is exported by
  // [[goals-table]] for [[../specs/goal-greenlight-button-and-author-writes-db]] — re-bind here so a
  // typecheck doesn't drop it. The function isn't called by this backfill (the explicit CEO greenlight
  // is a future surface).
  void setGoalStatus;
}

main().catch((e) => { console.error(e); process.exit(1); });
