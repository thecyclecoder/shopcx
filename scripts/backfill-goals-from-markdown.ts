// backfill-goals-from-markdown — goals-milestones-tables-and-backfill Phase 3 (db-driven-specs M5).
//
// Reads every docs/brain/goals/*.md, parses with `brain-roadmap.parseGoal` (the EXISTING parser,
// used ONE LAST TIME — readers stay markdown-first until goal-readers-from-db-retire-parsegoal),
// and INSERTs/UPSERTs rows into `public.goals` + `public.goal_milestones`. Then a second pass
// resolves `parent_goal_id` from "Reports to [[ceo-mode]]"-style wikilinks, and a third pass walks
// `public.specs` rows + writes `specs.milestone_id` where the spec's `parent` text matches a parsed
// milestone (unambiguously).
//
//   Dry run (default):  npx tsx scripts/backfill-goals-from-markdown.ts
//   Apply:              npx tsx scripts/backfill-goals-from-markdown.ts --apply
//
// Idempotent: re-running on stable markdown is a no-op. Multi-workspace safe (iterates every
// workspace). Status field on `goals` is NEVER overwritten on a re-run — a CEO greenlight survives.
import { readdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { createAdminClient } from "./_bootstrap";
import { parseGoal, type GoalCard, type Milestone } from "../src/lib/brain-roadmap";

const APPLY = process.argv.includes("--apply");
const GOALS_DIR = resolve(__dirname, "../docs/brain/goals");

type GoalStatus = "proposed" | "greenlit" | "complete" | "folded";
type MilestoneStatus = "planned" | "in_progress" | "complete";

interface ParsedGoal {
  slug: string;
  raw: string;
  card: GoalCard;
  parentSlug: string | null; // resolved from "Reports to [[slug]]" — slug only, FK uuid filled later
}

/** Pull the "Reports to [[slug]]" parent slug, if present. The wikilink target's last path segment
 *  is the goal slug ("ceo-mode" or "../goals/ceo-mode"). Returns null when no Reports-to line exists. */
function parseReportsTo(raw: string): string | null {
  const m = raw.match(/Reports to:?\s*\[\[([^\]|]+)/i);
  if (!m) return null;
  return m[1].trim().replace(/^.*\//, "").replace(/\.md$/, "");
}

/** Extract the markdown block for one milestone — the lines under `### M{N} — title` until the next
 *  `### ` heading or EOF. Returns null if the heading isn't found (graceful — body becomes null). */
function extractMilestoneBody(raw: string, milestone: Milestone): string | null {
  const lines = raw.split("\n");
  const id = milestone.id; // e.g. "M1"
  let inside = false;
  let body: string[] = [];
  for (const l of lines) {
    if (/^###\s+/.test(l)) {
      if (inside) break;
      // Heading must start the milestone block — match by id (M1 etc.) OR by the cleaned name.
      const headingText = l.replace(/^###\s+/, "");
      if ((id && new RegExp(`\\b${id}\\b`, "i").test(headingText)) ||
          (milestone.name && headingText.toLowerCase().includes(milestone.name.toLowerCase().slice(0, 24)))) {
        inside = true;
      }
      continue;
    }
    if (inside) body.push(l);
  }
  const text = body.join("\n").trim();
  return text || null;
}

/** Look up which workspace milestone (uuid) a spec's free-text `parent` references. Returns the
 *  milestone id when there's an unambiguous match (slug, title, OR Mn prefix on the goal's milestones);
 *  null otherwise (standalone spec — function mandate, ad-hoc, regression). */
function matchSpecParentToMilestone(
  parentText: string,
  goalsBySlug: Map<string, { id: string; title: string; milestones: { id: string; mid: string; name: string }[] }>,
): string | null {
  if (!parentText) return null;
  const p = parentText.toLowerCase();

  // Step 1: find the goal this parent references (slug or title match).
  let matchedGoal: { id: string; title: string; milestones: { id: string; mid: string; name: string }[] } | null = null;
  for (const [slug, g] of goalsBySlug) {
    const slugRe = new RegExp(`(^|[\\s/[(])${slug.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\b|$)`);
    if (slugRe.test(p) || (g.title && p.includes(g.title.toLowerCase()))) {
      if (matchedGoal && matchedGoal !== g) return null; // ambiguous — multiple goals match
      matchedGoal = g;
    }
  }
  if (!matchedGoal) return null;

  // Step 2: within that goal, find the unambiguous milestone. Match by Mn prefix first (the
  // dominant authored pattern: "**Parent:** ../goals/foo|M2 — title"), then by milestone title text.
  const mnRe = p.match(/\bm\d+\b/i);
  const candidates: string[] = [];
  for (const m of matchedGoal.milestones) {
    if (mnRe && m.id && m.id.toLowerCase() === mnRe[0].toLowerCase()) candidates.push(m.mid);
    else if (!mnRe && m.name && m.name.length >= 5 && p.includes(m.name.toLowerCase())) candidates.push(m.mid);
  }
  const uniq = [...new Set(candidates)];
  if (uniq.length === 1) return uniq[0];
  return null; // zero or multiple matches — keep null, the explicit standalone shape.
}

/** Map a `GoalCard.status` (parsed) → the DB enum. parseGoal returns `proposed|greenlit|complete`; we
 *  add `folded` only when the markdown carries an explicit `**Status:** folded` (no current goals do). */
function mapStatus(card: GoalCard, raw: string): GoalStatus {
  const explicit = raw.match(/\*\*Status:\*\*\s*folded/i);
  if (explicit) return "folded";
  return card.status as GoalStatus;
}

/** Roll up the initial milestone status from the spec rows we're about to attach. The DB trigger
 *  recomputes this on every subsequent specs.status write — this seeds it correctly at backfill time. */
function deriveInitialMilestoneStatus(specStatuses: string[]): MilestoneStatus {
  if (!specStatuses.length) return "planned";
  const allDone = specStatuses.every((s) => s === "shipped" || s === "folded");
  if (allDone) return "complete";
  if (specStatuses.some((s) => s === "in_progress")) return "in_progress";
  if (specStatuses.some((s) => s === "shipped" || s === "folded")) return "in_progress";
  return "planned";
}

async function main() {
  const admin = createAdminClient();

  // Load every goal markdown via parseGoal (specs=[] — we'll compute rollups from the DB instead).
  const slugs = readdirSync(GOALS_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => f.replace(/\.md$/, ""));
  const parsed: ParsedGoal[] = slugs.map((slug) => {
    const raw = readFileSync(resolve(GOALS_DIR, `${slug}.md`), "utf8");
    const card = parseGoal(slug, raw, []);
    return { slug, raw, card, parentSlug: parseReportsTo(raw) };
  });
  console.log(`Parsed ${parsed.length} goal markdown file(s)`);

  const { data: workspaces, error: wsErr } = await admin.from("workspaces").select("id, name");
  if (wsErr) throw wsErr;
  console.log(`Found ${(workspaces ?? []).length} workspace(s)`);

  for (const ws of (workspaces ?? []) as Array<{ id: string; name: string | null }>) {
    console.log(`\n--- workspace ${ws.id} (${ws.name ?? ""}) ---`);

    // Pre-load existing goals for this workspace (status survives a re-run).
    const { data: existingGoals } = await admin
      .from("goals")
      .select("id, slug, status")
      .eq("workspace_id", ws.id);
    const existingBySlug = new Map<string, { id: string; status: string }>();
    for (const g of (existingGoals ?? []) as Array<{ id: string; slug: string; status: string }>) {
      existingBySlug.set(g.slug, { id: g.id, status: g.status });
    }

    // PASS 1 — UPSERT goals rows (and their milestones).
    const slugToId = new Map<string, string>();
    // milestone bookkeeping for the spec-parent third pass.
    type MilestoneShape = { id: string; mid: string; name: string };
    const milestonesByGoalSlug = new Map<string, MilestoneShape[]>();
    const goalTitleBySlug = new Map<string, string>();

    for (const g of parsed) {
      const goalStatus = mapStatus(g.card, g.raw);
      const existing = existingBySlug.get(g.slug);

      const goalRow: Record<string, unknown> = {
        workspace_id: ws.id,
        slug: g.slug,
        title: g.card.title,
        body: g.raw,
        outcome: g.card.outcome || null,
        success_metric: g.card.successMetric || null,
        owner: g.card.owner ?? "platform",
        proposer_function: g.card.proposedBy ?? null,
        updated_at: new Date().toISOString(),
      };
      // Only set status on FIRST insert — never clobber a CEO greenlight on re-run.
      if (!existing) goalRow.status = goalStatus;

      console.log(
        `  goal ${g.slug}: ${existing ? `UPDATE id=${existing.id}` : `INSERT status=${goalStatus}`}` +
          `, ${g.card.milestones.length} milestone(s)`,
      );

      let goalId = existing?.id;
      if (APPLY) {
        const { data: up, error } = await admin
          .from("goals")
          .upsert(goalRow, { onConflict: "workspace_id,slug" })
          .select("id")
          .single();
        if (error) throw error;
        goalId = (up as { id: string }).id;
      } else {
        goalId = goalId ?? "<dry-run-uuid>";
      }
      slugToId.set(g.slug, goalId!);
      goalTitleBySlug.set(g.slug, g.card.title);

      // Milestones for this goal: pre-load existing rows by position to preserve id.
      const existingMs: Array<{ id: string; position: number }> = APPLY && existing
        ? ((await admin
            .from("goal_milestones")
            .select("id, position")
            .eq("goal_id", goalId!)).data as Array<{ id: string; position: number }>) ?? []
        : [];
      const existingMsByPos = new Map<number, string>();
      for (const m of existingMs) existingMsByPos.set(m.position, m.id);

      const shape: MilestoneShape[] = [];
      const desiredPositions = new Set<number>();

      for (let i = 0; i < g.card.milestones.length; i++) {
        const m = g.card.milestones[i];
        const position = i + 1;
        desiredPositions.add(position);
        const body = extractMilestoneBody(g.raw, m);
        const initialStatus = deriveInitialMilestoneStatus([]); // seed planned; trigger updates after specs attach.

        const prevId = existingMsByPos.get(position);
        const row: Record<string, unknown> = {
          goal_id: goalId,
          position,
          title: m.name ? (m.id ? `${m.id} — ${m.name}` : m.name) : (m.id || `M${position}`),
          body,
          updated_at: new Date().toISOString(),
        };
        if (prevId) row.id = prevId;
        if (!prevId) row.status = initialStatus;

        if (APPLY) {
          const { data: upM, error: mErr } = await admin
            .from("goal_milestones")
            .upsert(row, { onConflict: "goal_id,position" })
            .select("id")
            .single();
          if (mErr) throw mErr;
          shape.push({ id: m.id, mid: (upM as { id: string }).id, name: m.name });
        } else {
          shape.push({ id: m.id, mid: prevId ?? "<dry-run-uuid>", name: m.name });
        }
      }

      // Drop milestones that fell off the list (positions no longer present). FK on specs is on
      // delete set null, so attached specs survive with milestone_id reset.
      const toDelete: string[] = [];
      for (const [pos, id] of existingMsByPos) {
        if (!desiredPositions.has(pos)) toDelete.push(id);
      }
      if (toDelete.length && APPLY) {
        const { error: dErr } = await admin.from("goal_milestones").delete().in("id", toDelete);
        if (dErr) throw dErr;
        console.log(`    dropped ${toDelete.length} stale milestone row(s)`);
      } else if (toDelete.length) {
        console.log(`    would drop ${toDelete.length} stale milestone row(s)`);
      }

      milestonesByGoalSlug.set(g.slug, shape);
    }

    // PASS 2 — resolve parent_goal_id from "Reports to [[slug]]".
    let parentSet = 0;
    for (const g of parsed) {
      if (!g.parentSlug) continue;
      const parentUuid = slugToId.get(g.parentSlug);
      const selfUuid = slugToId.get(g.slug);
      if (!parentUuid || !selfUuid) continue;
      if (parentUuid === selfUuid) {
        console.log(`  WARN: ${g.slug} reports to itself — skipping parent set`);
        continue;
      }
      console.log(`  parent: ${g.slug} → ${g.parentSlug}`);
      parentSet++;
      if (APPLY) {
        const { error } = await admin
          .from("goals")
          .update({ parent_goal_id: parentUuid, updated_at: new Date().toISOString() })
          .eq("id", selfUuid);
        if (error) throw error;
      }
    }
    console.log(`  ${APPLY ? "set" : "would set"} parent_goal_id on ${parentSet} goal(s)`);

    // PASS 3 — specs.milestone_id from each spec's parent text.
    const goalsBySlug = new Map<string, { id: string; title: string; milestones: MilestoneShape[] }>();
    for (const [slug, ms] of milestonesByGoalSlug) {
      goalsBySlug.set(slug, { id: slugToId.get(slug)!, title: goalTitleBySlug.get(slug) || "", milestones: ms });
    }

    const { data: specs } = await admin
      .from("specs")
      .select("id, slug, parent, milestone_id, status")
      .eq("workspace_id", ws.id);
    let specsAttached = 0;
    let specsLeftStandalone = 0;
    const attachedByMilestone = new Map<string, string[]>(); // mid → [spec slugs]
    for (const s of (specs ?? []) as Array<{ id: string; slug: string; parent: string; milestone_id: string | null; status: string }>) {
      const matched = matchSpecParentToMilestone(s.parent || "", goalsBySlug);
      if (!matched) {
        if (!s.milestone_id) specsLeftStandalone++;
        continue;
      }
      if (s.milestone_id === matched) continue; // no-op on re-run
      specsAttached++;
      const list = attachedByMilestone.get(matched) ?? [];
      list.push(s.slug);
      attachedByMilestone.set(matched, list);
      if (APPLY) {
        const { error } = await admin
          .from("specs")
          .update({ milestone_id: matched, updated_at: new Date().toISOString() })
          .eq("id", s.id);
        if (error) throw error;
      }
    }
    console.log(`  ${APPLY ? "attached" : "would attach"} ${specsAttached} spec(s) to milestones; ${specsLeftStandalone} standalone`);

    // Per-goal summary line (spec required).
    for (const g of parsed) {
      const goalId = slugToId.get(g.slug);
      const attached = [...attachedByMilestone.values()].flat();
      const ms = milestonesByGoalSlug.get(g.slug) ?? [];
      const goalSpecCount = ms.reduce((n, m) => n + (attachedByMilestone.get(m.mid)?.length ?? 0), 0);
      const finalStatus = existingBySlug.get(g.slug)?.status ?? mapStatus(g.card, g.raw);
      void attached;
      void goalId;
      console.log(`  backfilled ${g.slug}: ${ms.length} milestones, status=${finalStatus}, ${goalSpecCount} specs attached`);
    }
  }

  // Final verification — markdown-parsed status vs DB status (per goal). Surface drift for human review.
  if (APPLY) {
    console.log(`\n=== post-apply status verification ===`);
    const { data: rows } = await admin.from("goals").select("workspace_id, slug, status");
    let mismatches = 0;
    for (const r of (rows ?? []) as Array<{ workspace_id: string; slug: string; status: string }>) {
      const p = parsed.find((x) => x.slug === r.slug);
      if (!p) continue;
      const expected = mapStatus(p.card, p.raw);
      // proposed → greenlit drift is EXPECTED (CEO may have greenlit since first backfill); only flag
      // backwards or unexpected mismatches (e.g. markdown says complete but DB says proposed).
      const RANK: Record<string, number> = { proposed: 0, greenlit: 1, complete: 2, folded: 3 };
      if ((RANK[r.status] ?? 0) < (RANK[expected] ?? 0)) {
        console.log(`  ⚠ ${r.slug}: markdown=${expected}, DB=${r.status} (manual review)`);
        mismatches++;
      }
    }
    console.log(`  ${mismatches === 0 ? "✓ no backwards drift" : `${mismatches} backwards drift(s)`}`);
  }

  console.log(`\n${APPLY ? "✓ backfill applied" : "(dry run — pass --apply to write)"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
