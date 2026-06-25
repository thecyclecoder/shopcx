/**
 * Brain roadmap reader — the source of truth for SpecCard rendering on the /dashboard/roadmap
 * board, the spec detail page, the Slack roadmap surfaces, and every script/agent that asks
 * "what's the state of spec X."
 *
 * spec-readers-from-db-retire-parser Phase 1 (2026-06-25): every SPEC read now comes from
 * `public.specs` + `public.spec_phases` via `readSpecsFromDb(workspaceId)` — the DB row IS the
 * truth. `parseSpec` + `overlayDbStateOnSpec` + `mergePhaseStates` still live in this file (so
 * a handful of consumers compile) but are NO LONGER on the `getRoadmap` / `getSpec` /
 * `listSpecSlugs` paths; Phase 3 retires them.
 *
 * goal-readers-from-db-retire-parsegoal (2026-06-25): every GOAL read now comes from `public.goals` +
 * `public.goal_milestones` via `getGoals` / `getGoal` / `getRoadmapFilters` / `listGoalSlugs` (mapping a
 * `GoalRow` → `GoalCard`); the markdown goal parser + its status deriver + the transitional status overlay
 * are RETIRED. A goal's milestone completion + rollup % is computed from its linked specs
 * (`specs.milestone_id` join), and its overall status is DERIVED — `complete` iff every milestone rolled up
 * `complete`, else the stored `goals.status`. The goal `body` is the only thing `getGoal().raw` carries
 * (the detail page renders it; residual `[[spec]]` wikilinks in it still feed membership filters).
 *
 * spec-pm-markdown-purge (2026-06-25): every per-spec + per-goal markdown file under docs/brain/specs/
 * and docs/brain/goals/ is DELETED — the DB is the sole source. The old `readSpecs()`/`buildSpecCards()`/
 * `readTracks()`/`parseTracks()` (the `## Active project …` tracks header) + the `tracks` field on
 * RoadmapData are GONE; `getRoadmap` returns `{ specs }` only. The functions/archive readers below stay
 * file-backed (functions/ + archive.d/ are permanent brain). `next.config.ts` still traces the
 * functions/archive markdown into the roadmap routes (the specs + goals markdown is no longer read).
 */
import { promises as fs } from "fs";
import path from "path";
import { listSpecs as listSpecsFromDb, getSpec as getSpecFromDb, specsForMilestone, type SpecRow, type SpecPhaseRow } from "@/lib/specs-table";
import { getGoal as getGoalFromDbRow, listGoals as listGoalsFromDb, type GoalRow, type GoalMilestoneRow } from "@/lib/goals-table";
// derive-rollup-status: the canonical phase→status rollup. spec-card-state only TYPE-imports from this
// module (Phase/SpecStatus), so this value import is runtime-cycle-free (the type import erases).
import { rollupPhaseStatus } from "@/lib/spec-card-state";

export type Phase = "planned" | "in_progress" | "shipped" | "rejected";

// A spec's WHOLE-spec board status. `deferred` is a first-class status orthogonal to phase progress
// (director-drives-all-specs-and-deferred-status Phase 1): a spec the board parks in its OWN column,
// excluded by every auto-build lane until the CEO un-defers it. Phases themselves are never `deferred`
// (no phase emoji maps to it) — only a SpecCard is, so `SpecPhase.status` + `counts` stay `Phase`.
// `in_review` (spec-review-agent): a NEWLY authored spec lands here — BEFORE `planned` — and can NEVER be
// built until the Spec-Review agent (Vale) checks it against the authoring guidelines and moves it to
// `planned` or `deferred`. Its own first column on the board. Like `deferred`, it's a SpecCard status only
// (phases stay `Phase`).
export type SpecStatus = Phase | "deferred" | "in_review";

export interface SpecPhase {
  title: string;
  status: Phase;
  /** spec-status-phase-pr-provenance Phase 3: the PR # + merge SHA that SHIPPED this phase. Surfaced from
   *  `spec_card_state.phase_states[i].{pr,merge_sha}` by `overlayDbStateOnSpec` / `mergePhaseStates` so the
   *  board and the spec-detail page can render a "P2 ✓ #519" PR chip per shipped phase (provable status). */
  pr?: number | null;
  merge_sha?: string | null;
}

export interface SpecCard {
  slug: string;
  title: string;
  status: SpecStatus;
  /** **Priority:** critical flag (director-executable-plans-and-priority) — orthogonal to status; the build
   *  lanes order a critical spec ahead of normal ones, and it can gate the queue until it ships. */
  critical?: boolean;
  summary: string;
  phases: SpecPhase[];
  counts: Record<Phase, number>;
  owner?: string; // function slug (DRI) from the **Owner:** [[../functions/x]] line
  parent?: string; // mandate or goal milestone from **Parent:**
  // Prerequisite specs from the **Blocked-by:** [[a]], [[b]] header line (spec-blockers). A blocker is
  // `cleared` when its own derived status is `shipped` OR it's archived/folded (no longer a live spec) —
  // i.e. the prerequisite code is on `main`. The board + the enqueue gate share this one source of truth.
  // Empty when the spec declares no Blocked-by. Resolved against the full spec set in getRoadmap/getSpec.
  blockedBy: { slug: string; title: string; status: Phase; cleared: boolean }[];
  // spec-blockers Phase 2 (auto-queue on unblock): when this spec's LAST blocker ships, its build is
  // auto-enqueued — unless the owner opts out with a `**Auto-build:** off` header line. `false` = opted
  // out (never auto-queued); undefined/true = default (eligible). Manual Build is unaffected either way.
  autoBuild?: boolean;
  // True when the spec body carries a **Repair-signature:** line (authored by the box Repair Agent).
  // The "🔧 Repair" source on the roadmap board's source filter is derived from this — see getRoadmapFilters.
  repairSignature: boolean;
  /** director-dismiss-park-and-short-circuit-spec Phase 2 — a shipped card was closed CLEANLY without all
   *  phases shipping ("we changed our mind"). Surfaced from `spec_card_state.flags.short_circuit` so the
   *  board renders the card distinctly ("shipped + short-circuited — <reason>"), and so the next reader
   *  doesn't mistake it for a fully-built spec. Reversible: the owner flipping status back to `planned`
   *  (or a director short-circuit=false action) clears the flag. */
  shortCircuited?: boolean;
  /** The reason captured at the moment of short-circuit (from `flags.short_circuit_reason`). */
  shortCircuitReason?: string;
  /** spec-status-phase-pr-provenance Phase 3: card-level shipping PR for a ONE-SHOT spec (a spec with no
   *  `## Phase` sections, where the whole spec ships in ONE PR). Surfaced from `spec_card_state.flags.merged_pr`
   *  so the board can render a card-level "✓ #PR" chip. Multi-phase specs leave this undefined; their
   *  per-phase PRs live in `phases[i].pr`. */
  shippedPr?: number | null;
}

export interface RoadmapData {
  specs: SpecCard[];
}

const ARCHIVE_FILE = path.join(process.cwd(), "docs", "brain", "archive.md");
const ARCHIVE_DIR = path.join(process.cwd(), "docs", "brain", "archive.d");

// NOTE: roadmap-reads-specs-from-git (reading spec markdown from `main` per-request via the GitHub API)
// was tried and RETIRED — per-request SHA polling burned the GitHub core quota (see spec-card-db-companion).
// The board reads the bundled `fs` copy below; the *live* project-management state (instant status + the
// deploy-pending flag) now comes from the spec_card_state DB mirror (src/lib/spec-card-state.ts), which the
// board overlays on top of this markdown parse — no GitHub API calls for status.

const PLANNED = "⏳";
const IN_PROGRESS = "🚧";
const SHIPPED = "✅";
const REJECTED = "❌";

/** Map a line's status emoji to a phase. A single marker wins; in-progress beats the rest. */
function statusFromText(s: string): Phase | null {
  if (s.includes(REJECTED)) return "rejected";
  if (s.includes(IN_PROGRESS)) return "in_progress";
  if (s.includes(PLANNED)) return "planned";
  if (s.includes(SHIPPED)) return "shipped";
  return null;
}

function stripEmoji(s: string): string {
  return s.replace(/[⏳🚧✅❌]/g, "").trim();
}

/** The phase's status emoji — the inverse of statusFromText. Used by the blocker chip + the gate error. */
export function phaseEmoji(p: Phase): string {
  return p === "shipped" ? SHIPPED : p === "in_progress" ? IN_PROGRESS : p === "rejected" ? REJECTED : PLANNED;
}

/** Strip bold markers + collapse [[wikilink|alias]] / [[wikilink]] to plain text for display. */
function cleanInline(s: string): string {
  return stripEmoji(s)
    .replace(/\*\*/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, link, alias) => alias || link)
    .trim();
}

function deriveStatus(counts: Record<Phase, number>, titleStatus: Phase | null, deferred: boolean): SpecStatus {
  // Deferred wins over phase progress (director-drives-all-specs-and-deferred-status Phase 1): a spec carrying
  // a `**Deferred:**` marker / `**Status:** deferred` is parked in its own column and excluded by every
  // auto-build lane, regardless of its ⏳ phases — until the CEO un-defers it (removes the marker).
  if (deferred) return "deferred";
  // A whole spec is never "rejected"; rejection is a phase-level state. Cut phases don't block shipped.
  const totalPhases = counts.planned + counts.in_progress + counts.shipped + counts.rejected;
  // Phase consensus beats a stale title: when every phase has shipped (none ⏳/🚧) and the title
  // isn't an explicit ❌ cut, the spec is shipped — a forgotten 🚧/⏳ in the H1 no longer overrides a
  // done phase set (observed: worker-self-update). Title still wins for an explicit ❌ cut and when
  // there are no phases at all.
  if (totalPhases > 0 && counts.planned === 0 && counts.in_progress === 0 && titleStatus !== "rejected") {
    return "shipped";
  }
  if (titleStatus && titleStatus !== "rejected") return titleStatus;
  if (counts.in_progress > 0) return "in_progress";
  if (counts.planned > 0) return "planned";
  if (counts.shipped > 0 || counts.rejected > 0) return "shipped";
  return "planned";
}

/** First plain paragraph after the H1 — skips blockquotes, headings, rules, tables. */
function firstParagraph(lines: string[]): string {
  let seenTitle = false;
  let started = false;
  const buf: string[] = [];
  for (const l of lines) {
    if (!seenTitle) {
      if (l.startsWith("# ")) seenTitle = true;
      continue;
    }
    const t = l.trim();
    if (!started) {
      if (!t || t.startsWith(">") || t.startsWith("#") || t.startsWith("---") || t.startsWith("|")) continue;
      started = true;
      buf.push(t);
    } else {
      if (!t || t.startsWith("#")) break;
      buf.push(t);
    }
  }
  return cleanInline(buf.join(" "));
}

export function parseSpec(slug: string, raw: string): SpecCard {
  const lines = raw.split("\n");

  let title = slug;
  let titleStatus: Phase | null = null;
  const titleLine = lines.find((l) => l.startsWith("# "));
  if (titleLine) {
    title = cleanInline(titleLine.slice(2));
    titleStatus = statusFromText(titleLine);
  }

  const phases: SpecPhase[] = [];
  // Accept a phase heading at H2 (`## Phase 1 — …`) OR H3 (`### Phase 1 — …` under a `## Phases` wrapper) —
  // both shapes are authored in the wild; matching only H2 left H3-phase specs with ZERO phases (so they
  // rolled up to `planned` forever, even after every build merged). `Phase\b` excludes the `## Phases` wrapper.
  const isPhaseHeading = (l: string) => /^#{2,3}\s+Phase\b/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^#{2,3}\s+(Phase\b.*)/);
    if (!m) continue;
    let st = statusFromText(lines[i]);
    if (!st) {
      // emoji may live on the first bullet under the heading — scan until the next phase heading / H2 section
      for (let j = i + 1; j < lines.length && !lines[j].startsWith("## ") && !isPhaseHeading(lines[j]); j++) {
        st = statusFromText(lines[j]);
        if (st) break;
      }
    }
    phases.push({ title: cleanInline(m[1]), status: st ?? "planned" });
  }

  // Fallback: specs that use a single "## Phases" section with per-phase BULLETS
  // (`- ⏳ **P1:** …`) instead of one "## Phase N — name <emoji>" heading per phase.
  // Many box-authored specs use this shape; without this they'd render zero phases on
  // the board. Only fires when no heading-phases were found, only inside the `## Phases`
  // section, and only for bullets that carry a phase emoji.
  if (phases.length === 0) {
    let inPhases = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+Phases?\s*$/i.test(lines[i])) { inPhases = true; continue; }
      if (inPhases && lines[i].startsWith("## ")) break; // next section ends the block
      if (!inPhases) continue;
      const bm = lines[i].match(/^\s*[-*]\s+(.*\S)\s*$/);
      if (!bm) continue;
      // A phase bullet is recognized by a leading status emoji (legacy) OR a `**P1**`/`**Phase 1**` label.
      // spec-status-db-driven Phase 3 stripped the emojis, so an emoji-less `- **P1 — …**` MUST still parse
      // as a phase (its status defaults to `planned`; the real status comes from the spec_card_state DB).
      const inner = bm[1].replace(/^[⏳🚧✅❌]\s*/, "");
      if (!statusFromText(lines[i]) && !/^\*{0,2}(P\d+|Phase\s+\d+)\b/i.test(inner)) continue;
      phases.push({ title: cleanInline(bm[1]), status: statusFromText(lines[i]) ?? "planned" });
    }
  }

  const counts: Record<Phase, number> = { planned: 0, in_progress: 0, shipped: 0, rejected: 0 };
  for (const p of phases) counts[p.status]++;

  // Taxonomy: **Owner:** [[../functions/{slug}]] · **Parent:** {mandate or goal milestone}
  let owner: string | undefined;
  let parent: string | undefined;
  for (const l of lines) {
    if (!owner) {
      const m = l.match(/\*\*Owner:\*\*\s*\[\[([^\]|]+)/);
      if (m) owner = m[1].replace(/^.*\//, "");
    }
    if (!parent) {
      const m = l.match(/\*\*Parent:\*\*\s*(.+?)\s*$/);
      if (m) parent = cleanInline(m[1]);
    }
    if (owner && parent) break;
  }

  // **Blocked-by:** [[spec-a]], [[spec-b]] — prerequisite specs (spec-blockers). Parsed like Owner/Parent;
  // each [[…]] resolves to a spec slug. Status/cleared are filled in by resolveBlockedBy against the full
  // spec set (parseSpec alone can't know another spec's status), so here we just capture the raw slugs.
  const blockerSlugs: string[] = [];
  for (const l of lines) {
    const bm = l.match(/\*\*Blocked-by:\*\*\s*(.+?)\s*$/i);
    if (!bm) continue;
    for (const wl of bm[1].matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      blockerSlugs.push(wl[1].trim().replace(/^.*\//, "").replace(/\.md$/, ""));
    }
    break;
  }

  // **Auto-build:** off — owner opt-out from spec-blockers Phase 2 auto-queue (parsed like Owner/Parent).
  // Default (no line) = on; only off/no/false/manual/disabled flips it false. Manual Build is unaffected.
  let autoBuild: boolean | undefined;
  for (const l of lines) {
    const am = l.match(/\*\*Auto-build:\*\*\s*(.+?)\s*$/i);
    if (!am) continue;
    autoBuild = !/^(off|no|false|manual|disabled?)\b/i.test(am[1].trim());
    break;
  }

  // **Repair-signature:** `…` — present only on box Repair-Agent-authored specs. Drives the board's
  // "🔧 Repair" source chip (roadmap-goal-and-source-filters). Derived, not author-tagged.
  const repairSignature = lines.some((l) => /\*\*Repair-signature:\*\*/i.test(l));

  // **Deferred:** … / **Status:** deferred — a first-class deferred spec
  // (director-drives-all-specs-and-deferred-status Phase 1). The `**Deferred:**` marker is already authored
  // by board-grooming split cards as a metadata LINE under the H1 (like Owner/Parent); `**Status:** deferred`
  // is an explicit opt-in. Either parks the spec in the Deferred board column and excludes it from every
  // auto-build lane until the CEO removes the marker. Anchored to line-start so a prose mention of the marker
  // inside backticks (e.g. this spec discussing `**Deferred:**`, or board-grooming documenting the note) is
  // NOT a false positive — only a real leading metadata line counts.
  const deferred = lines.some(
    (l) => /^\s*\*\*Deferred:\*\*/i.test(l) || /^\s*\*\*Status:\*\*\s*deferred\b/i.test(l),
  );

  // **Priority:** critical — a first-class priority flag (director-executable-plans-and-priority), ORTHOGONAL
  // to phase status (a spec can be planned+critical or in-progress+critical). Line-anchored like Deferred so a
  // prose mention in backticks isn't a false positive. Build lanes order a critical spec first (+ can gate).
  const critical = lines.some((l) => /^\s*\*\*Priority:\*\*\s*critical\b/i.test(l));

  return {
    slug,
    title,
    status: deriveStatus(counts, titleStatus, deferred),
    critical,
    summary: firstParagraph(lines),
    phases,
    counts,
    owner,
    parent,
    blockedBy: [...new Set(blockerSlugs)].map((s) => ({ slug: s, title: s, status: "planned" as Phase, cleared: false })),
    autoBuild,
    repairSignature,
  };
}

/**
 * Resolve a card's raw Blocked-by slugs against the live spec set (spec-blockers). A blocker is `cleared`
 * when its blocking spec's derived status is `shipped`, OR the slug is no longer a live spec at all
 * (archived/folded — it's left specs/ — or a dangling reference): a prerequisite already on `main` never
 * permanently blocks. Returns a fresh blockedBy array (title + status filled from the resolved spec).
 */
function resolveBlockedBy(card: SpecCard, bySlug: Map<string, SpecCard>): SpecCard["blockedBy"] {
  return card.blockedBy.map((b) => {
    const target = bySlug.get(b.slug);
    if (target) {
      // A deferred / in-review prerequisite hasn't shipped → still blocking; show it as ⏳ (the chip cares shipped-or-not).
      const status: Phase = target.status === "deferred" || target.status === "in_review" ? "planned" : target.status;
      return { slug: b.slug, title: target.title, status, cleared: target.status === "shipped" };
    }
    // Not a live spec → archived/folded (the prereq shipped + was retired into the brain) or a dangling
    // slug. Either way treat it as cleared so a Blocked-by pointing at an already-shipped/archived spec
    // never permanently blocks.
    return { slug: b.slug, title: b.slug, status: "shipped" as Phase, cleared: true };
  });
}

/**
 * spec-status-db-driven Phase 1: overlay the DB mirror onto a markdown-parsed SpecCard. status /
 * critical / deferred / per-phase status come from the DB authoritatively (the markdown lags by a
 * deploy, and Phase 3 strips the emojis entirely). Markdown is consulted only as a fallback when no DB
 * row exists yet (a brand-new spec the backfill hasn't reached).
 */
function overlayDbStateOnSpec<T extends SpecCard>(spec: T, state: import("@/lib/spec-card-state").SpecCardState | undefined): T {
  if (!state) return spec;
  const PHASE_RANK: Record<Phase, number> = { rejected: -1, planned: 0, in_progress: 1, shipped: 2 };
  // `flags.deferred` wins over phase rollup for display. Un-defer reveals the underlying rollup.
  const status: SpecStatus = state.flags?.deferred ? "deferred" : state.status;
  // Per-phase: DB is authoritative; markdown is the fallback for indices the DB doesn't know.
  // spec-status-phase-pr-provenance Phase 3: carry the PR/SHA provenance through so the board can render
  // a "P2 ✓ #519" chip per shipped phase.
  const byIndex = new Map((state.phase_states ?? []).map((p) => [p.index, p]));
  const phases = spec.phases.map((p, i) => {
    const db = byIndex.get(i);
    if (!db) return p;
    return { ...p, status: db.status, pr: db.pr ?? null, merge_sha: db.merge_sha ?? null };
  });
  // Forward-merge safety: if markdown has a more-advanced phase than the DB (a fresh edit), keep it
  // (and drop any stale DB provenance — the markdown is ahead).
  for (let i = 0; i < phases.length; i++) {
    if (PHASE_RANK[spec.phases[i].status] > PHASE_RANK[phases[i].status]) {
      phases[i] = spec.phases[i];
    }
  }
  const counts: Record<Phase, number> = { planned: 0, in_progress: 0, shipped: 0, rejected: 0 };
  for (const p of phases) counts[p.status]++;
  // director-dismiss-park-and-short-circuit-spec Phase 2 — surface short-circuit state from spec_card_state.flags
  // so the board renders a "shipped + short-circuited" sub-line with the reason.
  const rawScReason = state.flags?.short_circuit_reason;
  const shortCircuited = state.flags?.short_circuit === true ? true : spec.shortCircuited;
  const shortCircuitReason = typeof rawScReason === "string" && rawScReason ? rawScReason : spec.shortCircuitReason;
  // spec-status-phase-pr-provenance Phase 3: one-shot specs (no phases) carry their shipping PR at the
  // card level via `flags.merged_pr`. Surfaced as `shippedPr` so the board renders a card-level "✓ #PR" chip.
  const flagsMergedPr = state.flags?.merged_pr;
  const shippedPr = typeof flagsMergedPr === "number" ? flagsMergedPr : spec.shippedPr ?? null;
  return {
    ...spec,
    status,
    critical: !!state.flags?.critical || spec.critical,
    phases,
    counts,
    shortCircuited,
    shortCircuitReason,
    shippedPr,
  };
}

/**
 * The (effectively single-tenant) build-console workspace to resolve when a caller doesn't pass one — the
 * same "ride the latest agent_jobs row, fall back to the oldest workspace" rule the director/repair/security
 * agents use. spec-readers-from-db-retire-parser Phase 1: the SOLE source of spec rows is the DB, so every
 * getRoadmap/getSpec/listSpecSlugs caller needs a workspaceId. No-arg callers (org-chart at startup, the
 * legacy scripts/agents that haven't been retargeted yet) use this shim to pick the single-tenant workspace.
 */
async function resolveDefaultWorkspaceId(): Promise<string | null> {
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { data: job } = await admin.from("agent_jobs").select("workspace_id").order("created_at", { ascending: false }).limit(1).maybeSingle();
    const fromJob = (job as { workspace_id?: string } | null)?.workspace_id;
    if (fromJob) return fromJob;
    const { data: ws } = await admin.from("workspaces").select("id").order("created_at", { ascending: true }).limit(1).maybeSingle();
    return (ws as { id?: string } | null)?.id ?? null;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// DB-first readers (spec-readers-from-db-retire-parser Phase 1)
// ──────────────────────────────────────────────────────────────────────────────

/** A `public.specs` row carries an extra `folded` status not present on the SpecCard surface — folded
 *  specs are archived and never show on the board. Filter them out of the spec set. */
function isBoardableStatus(status: SpecRow["status"]): boolean {
  return status !== "folded";
}

/** Coerce the DB status enum (which adds `folded` over the SpecCard surface) to a `SpecStatus`. Folded is
 *  caller-filtered before this; this is for the boardable rows only. */
function dbStatusToSpecStatus(status: SpecRow["status"]): SpecStatus {
  if (status === "folded") return "shipped";
  return status;
}

/**
 * derive-rollup-status: a spec's BOARD status is computed from its phase children, never read from the
 * stored `specs.status` column (which is now vestigial for the planned/in_progress/shipped axis). The
 * canonical rollup (`rollupPhaseStatus`: ignore rejected; all shipped → shipped; any shipped/in_progress →
 * in_progress; else planned) is the same one the DB trigger maintains on `specs.status` and the merge hook
 * uses — so a stored status can never drift from the children, and the manual status-reconcile writes that
 * used to fight that drift are retired.
 *
 * Terminal / override statuses are NOT rollups and still win where they apply (they live on the row, not
 * the phases):
 *   - `deferred`   — the CEO parked the spec (specs.deferred flag); wins over phase progress.
 *   - `in_review`  — a newly-authored / sent-back spec awaiting Vale + Ada disposition; the build pipeline
 *                    refuses it, so it must read in_review regardless of any phase the body declares.
 *   - `folded`     — archived; callers filter it before this runs (isBoardableStatus), but preserved here.
 * A spec with ZERO phases (a one-shot spec) has nothing to roll up — fall back to the stored status (the
 * merge hook stamps `specs.status='shipped'` on its single-PR ship; in_progress/planned otherwise).
 */
function deriveSpecCardStatus(row: SpecRow, phases: SpecPhase[]): SpecStatus {
  if (row.deferred) return "deferred";
  if (row.status === "in_review") return "in_review";
  if (row.status === "folded") return "shipped"; // boardable callers filter folded; mirror dbStatusToSpecStatus
  if (!phases.length) return dbStatusToSpecStatus(row.status); // one-shot spec — no children to roll up
  return rollupPhaseStatus(phases.map((p, i) => ({ index: i, title: p.title, status: p.status })));
}

/** Build a SpecCard from one DB row + its joined `spec_phases`. The phases keep their stable id-by-position
 *  ordering from the join (specs-table.listSpecs sorts ASC by position). PR/merge_sha provenance flows
 *  through to the per-phase chip ([[spec-status-phase-pr-provenance]]). */
function dbRowToSpecCard(row: SpecRow): SpecCard {
  const phases: SpecPhase[] = row.phases.map((p: SpecPhaseRow) => ({
    title: p.title,
    status: p.status,
    pr: p.pr ?? null,
    merge_sha: p.merge_sha ?? null,
  }));
  const counts: Record<Phase, number> = { planned: 0, in_progress: 0, shipped: 0, rejected: 0 };
  for (const p of phases) counts[p.status]++;
  return {
    slug: row.slug,
    title: row.title,
    // derive-rollup-status: status is the PHASE ROLLUP, not the stored `specs.status` read — so a stored
    // status can never drift from the children. Terminal/override (deferred/in_review/folded) still win.
    status: deriveSpecCardStatus(row, phases),
    critical: row.priority === "critical" ? true : undefined,
    summary: row.summary ?? "",
    phases,
    counts,
    owner: row.owner || undefined,
    parent: row.parent || undefined,
    // blockedBy slugs come in raw; resolveBlockedBy fills title/status/cleared against the full set below.
    blockedBy: (row.blocked_by ?? []).map((slug) => ({ slug, title: slug, status: "planned" as Phase, cleared: false })),
    // tri-state on the SpecCard (undefined=eligible default, true=eligible, false=opted-out). The DB
    // boolean column lost the "no marker = default" distinction in the M1 backfill — mirror the current
    // dominant repo state (zero opt-outs) by mapping true→true and false→undefined so the default-eligible
    // semantics consumers rely on (`card.autoBuild !== false`) keep working.
    autoBuild: row.auto_build ? true : undefined,
    repairSignature: !!row.repair_signature,
  };
}

/** Overlay the transient `spec_card_state.flags` signals onto a card: short_circuit / short_circuit_reason
 *  (director-dismiss-park-and-short-circuit-spec) and one-shot `flags.merged_pr` (the card-level shipping PR
 *  for a no-phase spec — spec-status-phase-pr-provenance). These aren't on `public.specs` yet, so we
 *  surface them here. Per-phase PR/merge_sha provenance now lives on `spec_phases` directly (see
 *  dbRowToSpecCard) — no overlay needed. */
function overlayCardFlags(card: SpecCard, state: import("@/lib/spec-card-state").SpecCardState | undefined): SpecCard {
  if (!state) return card;
  const rawScReason = state.flags?.short_circuit_reason;
  const shortCircuited = state.flags?.short_circuit === true ? true : undefined;
  const shortCircuitReason = typeof rawScReason === "string" && rawScReason ? rawScReason : undefined;
  const flagsMergedPr = state.flags?.merged_pr;
  const shippedPr = typeof flagsMergedPr === "number" ? flagsMergedPr : null;
  return { ...card, shortCircuited, shortCircuitReason, shippedPr };
}

const SPEC_RANK: Record<SpecStatus, number> = { in_progress: 0, in_review: 1, planned: 2, shipped: 3, deferred: 4, rejected: 5 };

/** Read every boardable spec from `public.specs` + `public.spec_phases` for a workspace, build SpecCards,
 *  resolve Blocked-by slugs against the live set, and (when card-state rows exist) overlay the transient
 *  short-circuit / one-shot-PR flags. This REPLACES the old `readSpecs()` (parseSpec across the .md files).
 *  Sorted by board column then title — the same order callers used to get from the markdown reader. */
async function readSpecsFromDb(workspaceId: string): Promise<SpecCard[]> {
  const rows = (await listSpecsFromDb(workspaceId)).filter((r) => isBoardableStatus(r.status));
  const cards = rows.map(dbRowToSpecCard);
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  for (const c of cards) c.blockedBy = resolveBlockedBy(c, bySlug);
  // Card-state overlay (short_circuit / merged_pr) — best-effort. A missing table / read error leaves cards
  // un-overlaid (the canonical row already carries the truth for everything else).
  try {
    const { getSpecCardStates } = await import("@/lib/spec-card-state");
    const states = await getSpecCardStates(workspaceId);
    for (let i = 0; i < cards.length; i++) cards[i] = overlayCardFlags(cards[i], states[cards[i].slug]);
  } catch {
    /* best-effort overlay — the DB row is authoritative for everything else. */
  }
  return cards.sort((a, b) => SPEC_RANK[a.status] - SPEC_RANK[b.status] || a.title.localeCompare(b.title));
}

/** Serialize a DB SpecRow back to a markdown blob with the same shape parseSpec/extractSpecSection/
 *  parseRepairSpecMeta/parseFixesLink/parseGoalSpecBlockers/buildSpecModal expect — preserves the H1, the
 *  metadata header lines (Owner / Parent / Blocked-by / Priority / Deferred / Auto-build /
 *  Repair-signature / Regression-of / Regression-signature), the summary paragraph, one `## Phase N — …`
 *  block per phase with the stored body, and (when any phase has verification) a single concatenated
 *  `## Verification` section. The reconstruction lets every downstream consumer that reads `getSpec().raw`
 *  keep compiling AND parsing — even though the source is now the DB, not the .md. */
function serializeSpecRowToMarkdown(row: SpecRow): string {
  const out: string[] = [];
  out.push(`# ${row.title}`);
  out.push("");
  const headerBits: string[] = [];
  if (row.owner) headerBits.push(`**Owner:** [[../functions/${row.owner}]]`);
  if (row.parent) headerBits.push(`**Parent:** ${row.parent}`);
  if (headerBits.length) out.push(headerBits.join(" · "));
  if (row.blocked_by && row.blocked_by.length) {
    out.push(`**Blocked-by:** ${row.blocked_by.map((s) => `[[${s}]]`).join(", ")}`);
  }
  if (row.priority === "critical") out.push("**Priority:** critical");
  if (row.deferred) out.push("**Deferred:** parked");
  if (row.auto_build) out.push("**Auto-build:** on");
  if (row.repair_signature) out.push(`**Repair-signature:** \`${row.repair_signature}\``);
  if (row.regression_of_slug) out.push(`**Regression-of:** [[${row.regression_of_slug}]]`);
  if (row.regression_signature) out.push(`**Regression-signature:** \`${row.regression_signature}\``);
  out.push("");
  if (row.summary && row.summary.trim()) {
    out.push(row.summary.trim());
    out.push("");
  }
  // Phases (the DB orders them ASC by position via the join). Stored body is markdown-as-text; emit a
  // `## Phase N — {title}` heading and the body verbatim.
  const phases = row.phases.slice().sort((a, b) => a.position - b.position);
  for (const p of phases) {
    out.push(`## Phase ${p.position} — ${p.title}`);
    out.push("");
    if (p.body && p.body.trim()) {
      out.push(p.body.trim());
      out.push("");
    }
  }
  // Concatenate per-phase verification (`spec_phases.verification`) into a single `## Verification` block —
  // the shape extractSpecSection/parseVerificationBullets expects. When more than one phase carries a
  // verification block, prefix each with a `**Phase N:**` label so the order survives.
  const withVerification = phases.filter((p) => p.verification && p.verification.trim());
  if (withVerification.length) {
    out.push("## Verification");
    out.push("");
    if (withVerification.length === 1) {
      out.push(withVerification[0].verification!.trim());
      out.push("");
    } else {
      for (const p of withVerification) {
        out.push(`**Phase ${p.position}:**`);
        out.push("");
        out.push(p.verification!.trim());
        out.push("");
      }
    }
  }
  return out.join("\n");
}

export async function getRoadmap(workspaceId?: string): Promise<RoadmapData> {
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  // No workspace → empty board. We fail loud (empty result, no markdown fallback) so an outage is visible
  // rather than papered over with a stale disk parse. spec-readers-from-db-retire-parser safety rail.
  const specs = wsId ? await readSpecsFromDb(wsId) : [];
  return { specs };
}

/** Slugs of every boardable spec — DB-driven (no fs read). Used to resolve [[wikilinks]] to detail pages. */
export async function listSpecSlugs(): Promise<string[]> {
  const wsId = await resolveDefaultWorkspaceId();
  if (!wsId) return [];
  const rows = await listSpecsFromDb(wsId);
  return rows.filter((r) => isBoardableStatus(r.status)).map((r) => r.slug);
}

// ── Taxonomy map: Function → (Mandate | Goal) → Spec ──

/** Pretty display name for a function slug (acronyms uppercased). */
const FUNCTION_LABELS: Record<string, string> = {
  growth: "Growth", cmo: "CMO", retention: "Retention",
  cfo: "CFO", logistics: "Logistics", cs: "CS", platform: "Platform / Eng",
};
export function functionLabel(slug: string): string {
  return FUNCTION_LABELS[slug] || slug.replace(/(^|[-_])(\w)/g, (_m, sep, c) => (sep ? " " : "") + c.toUpperCase());
}

/** The mandate/goal name from a spec's parent line — the quoted part if present, else the whole string. */
export function parentLabel(parent: string): string {
  const q = parent.match(/"([^"]+)"/);
  return q ? q[1] : parent;
}

export interface ParentGroup {
  parent: string; // raw parent string (groups by this)
  label: string; // cleaned mandate/goal name
  specs: SpecCard[];
}
export interface FunctionGroup {
  fn: string; // owner slug
  label: string; // display name
  total: number;
  counts: Record<SpecStatus, number>; // per-status spec counts incl. `deferred` (its own taxonomy-map pill)
  groups: ParentGroup[];
}
export interface FunctionMap {
  functions: FunctionGroup[];
  unassigned: SpecCard[]; // specs with no owner (should be empty — the no-orphan rule)
}

/** Order: CEO-mode business directors first, the build org last, unknowns after. */
const FUNCTION_ORDER = ["growth", "cmo", "retention", "cfo", "logistics", "cs", "platform"];

/**
 * Group every spec by Function (owner) → Mandate/Goal (parent) for the
 * big-picture taxonomy view. Built from the specs themselves (owner +
 * parent lines), so it's always in sync with the no-orphan rule.
 */
export async function getFunctionMap(workspaceId?: string): Promise<FunctionMap> {
  const { specs } = await getRoadmap(workspaceId);
  const byFn = new Map<string, SpecCard[]>();
  const unassigned: SpecCard[] = [];
  for (const s of specs) {
    if (!s.owner) { unassigned.push(s); continue; }
    const arr = byFn.get(s.owner) || [];
    arr.push(s);
    byFn.set(s.owner, arr);
  }
  const ord = (fn: string) => { const i = FUNCTION_ORDER.indexOf(fn); return i < 0 ? 99 : i; };
  const functions: FunctionGroup[] = [...byFn.entries()]
    .sort((a, b) => ord(a[0]) - ord(b[0]) || a[0].localeCompare(b[0]))
    .map(([fn, list]) => {
      const counts: Record<SpecStatus, number> = { planned: 0, in_progress: 0, in_review: 0, shipped: 0, deferred: 0, rejected: 0 };
      for (const s of list) counts[s.status]++;
      const pmap = new Map<string, SpecCard[]>();
      for (const s of list) {
        const key = s.parent || "(unparented)";
        const arr = pmap.get(key) || [];
        arr.push(s);
        pmap.set(key, arr);
      }
      const rank: Record<SpecStatus, number> = { in_progress: 0, in_review: 1, planned: 2, shipped: 3, deferred: 4, rejected: 5 };
      const groups: ParentGroup[] = [...pmap.entries()]
        .map(([parent, ss]) => ({ parent, label: parentLabel(parent), specs: ss.sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title)) }))
        .sort((a, b) => a.label.localeCompare(b.label));
      return { fn, label: functionLabel(fn), total: list.length, counts, groups };
    });
  return { functions, unassigned };
}

// ── Archive index (docs/brain/archive.md) — verified, retired specs ──

export interface ArchiveEntry {
  title: string;
  date: string; // verified date, "YYYY-MM-DD" (or "" if unparseable)
  link: string; // brain-relative slug the entry points at, e.g. "lifecycles/roadmap-build-console"
  label: string; // display label for the link (last path segment, humanized)
}

/** Parse one archive entry list item ("- **Title** · verified YYYY-MM-DD · → [[link]]") → entry, or null. */
function parseArchiveLine(line: string): ArchiveEntry | null {
  const t = line.trim();
  if (!t.startsWith("- ")) return null;
  const link = t.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
  if (!link) return null; // index rows always carry a wikilink; prose/placeholder don't
  const target = link[1].trim().replace(/^\.\.\//, "").replace(/\.md$/, "");
  const date = (t.match(/verified\s+(\d{4}-\d{2}-\d{2})/i) || [])[1] || "";
  const titleM = t.match(/\*\*(.+?)\*\*/);
  const title = titleM ? cleanInline(titleM[1]) : cleanInline(t.slice(2).split("·")[0]);
  const label = functionLabel(target.replace(/^.*\//, "")); // humanize last segment
  return { title, date, link: target, label };
}

/**
 * Verified/retired features for the board's Archived section. Each is one entry shaped
 *   - **Title** · verified YYYY-MM-DD · → [[lifecycles/{slug}]]
 *
 * spec-fold-from-db-row Phase 2 (2026-06-25): the LISTING now comes from `public.specs` where
 * `status='folded'` — the folded row is the source of truth ([[spec-fold-from-db-row]] Phase 1 flipped
 * the status; the row is PRESERVED on fold so this query renders the archive directly). The per-spec
 * `docs/brain/archive.d/{slug}.md` file (still committed by the fold worker for the git-history-of-
 * shipped-specs use case the [[spec-test-agent]] reads via `listArchivedSlugs`) is consulted ONLY as a
 * best-effort LINK ENRICHMENT — it carries the fold-agent's analysis of where the durable knowledge
 * lives (e.g. `→ [[lifecycles/ai-learning]]` vs the spec slug). Absent / unparseable archive.d entries
 * fall back to `lifecycles/{slug}`. When no `workspaceId` is supplied (a script / cron with no workspace
 * scope), we fall back to the pre-Phase-2 filesystem read for parity.
 *
 * Newest first, tie-broken by slug.
 */
/** Build the archive index from its inputs (source-agnostic): prefer per-spec archive.d/ files, else archive.md. */
function buildArchiveEntries(archiveD: { slug: string; raw: string }[], archiveMd: string | null): ArchiveEntry[] {
  if (archiveD.length) {
    const parsed = archiveD
      .map(({ slug, raw }) => {
        const line = raw.split("\n").find((l) => l.trim().startsWith("- "));
        const entry = line ? parseArchiveLine(line) : null;
        return entry ? { slug, entry } : null;
      })
      .filter((x): x is { slug: string; entry: ArchiveEntry } => x !== null);
    if (parsed.length) {
      parsed.sort((a, b) => b.entry.date.localeCompare(a.entry.date) || a.slug.localeCompare(b.slug));
      return parsed.map((e) => e.entry);
    }
  }
  if (!archiveMd) return [];
  const entries: ArchiveEntry[] = [];
  for (const line of archiveMd.split("\n")) {
    const entry = parseArchiveLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

/** Read the per-spec archive.d/ files into a slug → parsed-entry map for link enrichment. Best-effort:
 *  an absent / unreadable directory yields an empty map. */
async function loadArchiveDirEntries(): Promise<Map<string, ArchiveEntry>> {
  const out = new Map<string, ArchiveEntry>();
  try {
    const files = (await fs.readdir(ARCHIVE_DIR)).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
    await Promise.all(
      files.map(async (f) => {
        const slug = f.replace(/\.md$/, "");
        const raw = await fs.readFile(path.join(ARCHIVE_DIR, f), "utf8");
        const line = raw.split("\n").find((l) => l.trim().startsWith("- "));
        const entry = line ? parseArchiveLine(line) : null;
        if (entry) out.set(slug, entry);
      }),
    );
  } catch {
    /* no archive.d/ — the DB row carries title + date directly, link defaults to lifecycles/{slug}. */
  }
  return out;
}

export async function getArchive(workspaceId?: string): Promise<ArchiveEntry[]> {
  // spec-fold-from-db-row Phase 2: the LISTING comes from the DB row — every folded spec is one row
  // with `status='folded'`, title, slug, and an updated_at that's the verified date. Workspace-scoped.
  if (workspaceId) {
    let folded: SpecRow[];
    try {
      folded = await listSpecsFromDb(workspaceId, { status: "folded" });
    } catch {
      folded = [];
    }
    // archive.d/ ENRICHMENT — preserves the fold-agent's chosen link target where available; absent
    // entries fall back to lifecycles/{slug}. The presence/absence of archive.d/ never affects the
    // LIST of folded specs — only the per-entry link.
    const enrichment = await loadArchiveDirEntries();
    const entries: ArchiveEntry[] = folded.map((row) => {
      const enriched = enrichment.get(row.slug);
      if (enriched) {
        return { title: enriched.title || row.title, date: enriched.date || isoDate(row.updated_at), link: enriched.link, label: enriched.label };
      }
      const link = `lifecycles/${row.slug}`;
      return { title: row.title, date: isoDate(row.updated_at), link, label: functionLabel(row.slug) };
    });
    entries.sort((a, b) => b.date.localeCompare(a.date) || a.link.localeCompare(b.link));
    if (entries.length) return entries;
    /* No folded rows yet — fall through to the filesystem path for backward compat (the very first
       Phase 1 fold runs after this code deploys; before that, the only archive entries live on disk). */
  }

  let archiveD: { slug: string; raw: string }[] = [];
  try {
    const files = (await fs.readdir(ARCHIVE_DIR)).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
    archiveD = await Promise.all(
      files.map(async (f) => ({ slug: f.replace(/\.md$/, ""), raw: await fs.readFile(path.join(ARCHIVE_DIR, f), "utf8") })),
    );
  } catch {
    /* no archive.d/ (or unreadable) — fall back to the generated archive.md */
  }
  let archiveMd: string | null = null;
  try {
    archiveMd = await fs.readFile(ARCHIVE_FILE, "utf8");
  } catch {
    /* no archive.md either */
  }
  return buildArchiveEntries(archiveD, archiveMd);
}

/** "2026-06-25T17:00:00.000Z" → "2026-06-25". */
function isoDate(s: string): string {
  return (s || "").slice(0, 10);
}

/**
 * Slugs of every archived (verified + folded) spec — the `docs/brain/archive.d/{slug}.md` filenames.
 * A spec is "shipped but not archived" when it's still in specs/ AND its slug isn't here. Used by the
 * spec-test cron (spec-test-agent) to skip specs already past the verify gate. Empty if archive.d/ is absent.
 */
export async function listArchivedSlugs(): Promise<string[]> {
  try {
    return (await fs.readdir(ARCHIVE_DIR))
      .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

/**
 * Pull the body of a top-level "## {heading}" section out of spec markdown (everything between
 * the heading and the next "## " / EOF). Returns the trimmed body, or null if the heading is absent.
 * Used to lift the "## Verification" test plan out of a spec for the detail page's verify card.
 */
export function extractSpecSection(raw: string, heading: string): string | null {
  const lines = raw.split("\n");
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

/** Same locating logic as extractSpecSection, but returns the markdown with that section removed. */
export function stripSpecSection(raw: string, heading: string): string {
  const lines = raw.split("\n");
  const re = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
  const start = lines.findIndex((l) => re.test(l));
  if (start === -1) return raw;
  let end = start + 1;
  while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Raw markdown + parsed card for one spec, or null if it doesn't exist. Slug is path-guarded. */
/**
 * Derive a spec's overall status from its raw markdown (no disk read) — the same deriveStatus the
 * board uses, exposed for callers that hold freshly-committed content in memory (e.g. /api/roadmap/status
 * computing the result of a status flip before disk reflects it). See spec-test-on-ship.
 */
export function deriveSpecStatus(raw: string): SpecStatus {
  return parseSpec("_", raw).status;
}

export async function getSpec(slug: string, workspaceId?: string): Promise<{ raw: string; card: SpecCard } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  if (!wsId) return null;
  // spec-readers-from-db-retire-parser Phase 1: ONE SQL query for the card + reconstruct raw from the row.
  // No fs read, no parseSpec. Folded specs are archive territory — return null (matches the old
  // "file gone from disk" shape that the fold worker produced).
  const row = await getSpecFromDb(wsId, slug);
  if (!row || !isBoardableStatus(row.status)) return null;
  let card = dbRowToSpecCard(row);
  // Resolve Blocked-by against the live workspace set so the detail page's BuildButton sees the same
  // cleared/uncleared state as the board (spec-blockers).
  const specs = await readSpecsFromDb(wsId);
  card.blockedBy = resolveBlockedBy(card, new Map(specs.map((c) => [c.slug, c])));
  // Card-state overlay for the transient short-circuit / one-shot-PR flags that aren't on `public.specs`.
  try {
    const { getSpecCardStates } = await import("@/lib/spec-card-state");
    const cardStates = await getSpecCardStates(wsId);
    card = overlayCardFlags(card, cardStates[slug]);
  } catch {
    /* best-effort overlay — the canonical row is still correct without it. */
  }
  return { raw: serializeSpecRowToMarkdown(row), card };
}

/**
 * Resolved Blocked-by entries for one spec (spec-blockers) — the source of truth the enqueue gate
 * (queueRoadmapBuild) checks before inserting a build row. Empty if the spec has no Blocked-by or
 * doesn't exist. A blocker with `cleared:false` must ship before the spec can be built.
 */
export async function getSpecBlockers(slug: string): Promise<SpecCard["blockedBy"]> {
  const { specs } = await getRoadmap();
  return specs.find((s) => s.slug === slug)?.blockedBy ?? [];
}

// ══════════════════════════════════════════════════════════════════════════
// Functions + Goals + Mandates — the layer ABOVE specs (goal-decomposition-engine).
// Markdown-first: functions live in docs/brain/functions/, goals in docs/brain/goals/.
// A spec's owner (function) + parent (mandate | goal-milestone) is parsed on SpecCard;
// here we parse the function/goal docs themselves and roll specs' phase completion up.
// ══════════════════════════════════════════════════════════════════════════

const FUNCTIONS_DIR = path.join(process.cwd(), "docs", "brain", "functions");

/** A perpetual charter (### heading under "## Mandates") a function owns — metric-tracked, never %-complete. */
export interface Mandate {
  name: string; // the ### heading text
  metric?: string; // the **Metric:** line, if any
  specSlugs: string[]; // [[../specs/x]] wikilinks under this mandate
}

export interface FunctionCard {
  slug: string;
  title: string;
  summary: string; // first paragraph (scope)
  mandates: Mandate[];
  goalSlugs: string[]; // owned / contributed goals (wikilinks under "## Owned / contributed goals")
}

/** One milestone of a finite goal — its own status emoji + the specs that build it. */
export interface Milestone {
  id: string; // "M0" etc, or "" if unlabelled
  name: string; // milestone title text
  status: Phase; // emoji on the bullet (defaults planned)
  metric?: string;
  specSlugs: string[];
  completion: number; // 0..1 — avg of linked specs' completion (or status if none linked)
}

/**
 * A goal's lifecycle state (director-proposed-goals spec). `proposed` — a director authored it and it
 * AWAITS the CEO's greenlight (inert: the escort doesn't touch it, Pia doesn't decompose it). `greenlit` —
 * the CEO approved it; it's active (a greenlit 0% goal is ready for decomposition, an in-progress one is
 * escorted). `complete` — 100%. Replaces the old `pct > 0`-infers-greenlit hack: `proposed` is now an
 * EXPLICIT `**Status:** proposed` marker, so a proposed 0% goal is unambiguously distinct from an active 0%
 * one. A goal with no `**Status:**` line is a legacy CEO goal — treated as `greenlit` (or `complete` at 100%).
 */
export type GoalStatus = "proposed" | "greenlit" | "complete";

export interface GoalCard {
  slug: string;
  title: string;
  outcome: string; // **Outcome:** …
  successMetric: string; // **Success metric:** …
  target: string; // **Target:** …
  owner?: string; // function slug (the DRI) from the goal's `Owner: [[../functions/x]]` line
  status: GoalStatus; // **Status:** line (proposed｜greenlit｜complete); legacy no-Status goals ⇒ greenlit
  proposedBy?: string; // function slug from a `**Proposed-by:** [[../functions/x]]` marker (director-proposed only)
  milestones: Milestone[];
  pct: number; // 0..100 rollup of milestone completion
  linkedSpecCount: number; // resolvable specs across milestones
}

/** How "done" a spec is, 0..1: shipped status ⇒ 1; else shipped phases / non-cut phases. */
export function specCompletion(card: SpecCard): number {
  if (card.status === "shipped") return 1;
  const live = card.counts.planned + card.counts.in_progress + card.counts.shipped;
  if (live === 0) return card.status === "in_progress" ? 0.5 : 0;
  return card.counts.shipped / live;
}

/** Pull [[../specs/x]] / [[x]] wikilink slugs (spec-relative, last path segment) from a blob. */
function specWikilinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = m[1].trim();
    // only spec links: either ../specs/x or a bare slug; skip goals/functions/lifecycles/etc.
    if (/\//.test(target) && !/(^|\/)specs\//.test(target)) continue;
    out.push(target.replace(/^.*\//, "").replace(/\.md$/, ""));
  }
  return out;
}

/** All [[goal-slug]] / [[../goals/x]] wikilink slugs in a blob. */
function goalWikilinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = m[1].trim();
    if (/(^|\/)goals\//.test(target)) out.push(target.replace(/^.*\//, "").replace(/\.md$/, ""));
  }
  return out;
}

/** Collect the lines belonging to a "## Heading" section (until the next ## / EOF). */
function sectionLines(lines: string[], headingRe: RegExp): string[] {
  const out: string[] = [];
  let inside = false;
  for (const l of lines) {
    if (l.startsWith("## ")) {
      if (inside) break;
      inside = headingRe.test(l);
      continue;
    }
    if (inside) out.push(l);
  }
  return out;
}

export function parseFunction(slug: string, raw: string): FunctionCard {
  const lines = raw.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? cleanInline(titleLine.slice(2)).replace(/\s*\(function\)\s*$/i, "") : functionLabel(slug);

  // Mandates: each ### under "## Mandates" is a perpetual charter.
  const mandates: Mandate[] = [];
  const mandateLines = sectionLines(lines, /^##\s+Mandates/i);
  let cur: Mandate | null = null;
  for (const l of mandateLines) {
    const h = l.match(/^###\s+(.+)/);
    if (h) {
      cur = { name: cleanInline(h[1]), specSlugs: [] };
      mandates.push(cur);
      continue;
    }
    if (!cur) continue;
    const metric = l.match(/\*\*Metric:\*\*\s*(.+)/i);
    if (metric && !cur.metric) cur.metric = cleanInline(metric[1]);
    cur.specSlugs.push(...specWikilinks(l));
  }
  for (const m of mandates) m.specSlugs = [...new Set(m.specSlugs)];

  // Owned / contributed goals.
  const goalSlugs = [...new Set(goalWikilinks(sectionLines(lines, /^##\s+Owned/i).join("\n")))];

  return { slug, title, summary: firstParagraph(lines), mandates, goalSlugs };
}

// ──────────────────────────────────────────────────────────────────────────────
// DB-first goal readers (goal-readers-from-db-retire-parsegoal)
//
// Goals now live in `public.goals` + `public.goal_milestones` (relational rows), with child specs in
// `public.specs` (milestone_id FK). These readers map a `GoalRow` (+ its joined milestones) into the same
// `GoalCard` the old markdown reader produced — the page/agent surfaces are unchanged. The DB row IS the
// truth: the markdown goal parser, its status deriver, and the transitional status overlay are RETIRED.
// ──────────────────────────────────────────────────────────────────────────────

/** A goals-row status maps 1:1 to GoalCard.status for the non-folded states. Folded is caller-filtered
 *  (a folded goal is gone from the active board / returns null from getGoal). */
function dbGoalRowStatus(status: GoalRow["status"]): GoalStatus {
  if (status === "complete") return "complete";
  if (status === "proposed") return "proposed";
  return "greenlit"; // greenlit (and the never-surfaced folded, which callers filter first)
}

/** Pull a `**Target:**` line out of a goal's body (the markdown detail), or "" when absent — the one
 *  GoalCard field that has no first-class column on `public.goals`. */
function targetFromBody(body: string): string {
  for (const l of body.split("\n")) {
    const m = l.match(/\*\*Target:\*\*\s*(.+)/i);
    if (m) return cleanInline(m[1]);
  }
  return "";
}

/**
 * Map one milestone row → a `Milestone` card, computing `completion` (0..1) from its linked specs (the
 * same shape the old reader produced): the mean of each linked spec's `specCompletion`. With no linked
 * specs the milestone falls back to its own rolled-up status (`complete` ⇒ 1, else 0) — mirroring the old
 * "shipped emoji ⇒ 1, else 0" fallback. `status` is a `Phase` projection of the milestone's DB rollup
 * status (`complete` → shipped, `in_progress` → in_progress, else planned).
 */
function milestoneRowToCard(m: GoalMilestoneRow, linked: SpecCard[]): Milestone {
  const status: Phase = m.status === "complete" ? "shipped" : m.status === "in_progress" ? "in_progress" : "planned";
  const completion = linked.length
    ? linked.reduce((a, s) => a + specCompletion(s), 0) / linked.length
    : m.status === "complete"
      ? 1
      : 0;
  // Milestone title carries the human label (and any `M1 — ` prefix) — surface it as the card name. Its
  // body may contain a `**Metric:**` line + spec wikilinks (used by getRoadmapFilters membership).
  const specSlugs = [...new Set(specWikilinks(`${m.title}\n${m.body ?? ""}`))];
  const metricm = (m.body ?? "").match(/\*\*Metric:\*\*\s*([^\n]+)/i);
  return {
    id: (m.title.match(/^\s*\*{0,2}\s*(M\d+)\b/) || [])[1] ?? "",
    name: cleanInline(m.title),
    status,
    metric: metricm ? cleanInline(metricm[1]) : undefined,
    specSlugs,
    completion,
  };
}

/**
 * Build a `GoalCard` from a `GoalRow` (+ its joined milestones) by reading each milestone's linked specs
 * from the spec set passed in (the same `getRoadmap().specs` the board uses, keyed by milestone id). `pct`
 * is the mean of milestone completion ×100; `linkedSpecCount` is the total resolvable specs across the
 * goal's milestones. Status is DERIVED, not read blindly: a goal whose milestones ALL complete is
 * `complete` regardless of the stored value — completion is inferred from children.
 */
function goalRowToCard(row: GoalRow, specsByMilestone: Map<string, SpecCard[]>): GoalCard {
  let linkedSpecCount = 0;
  const milestones = row.milestones.map((m) => {
    const linked = specsByMilestone.get(m.id) ?? [];
    linkedSpecCount += linked.length;
    return milestoneRowToCard(m, linked);
  });
  const pct = milestones.length
    ? Math.round((milestones.reduce((a, m) => a + m.completion, 0) / milestones.length) * 100)
    : 0;
  // DERIVED status: a goal with milestones that ALL roll up `complete` IS complete (inferred from
  // children); otherwise the stored row status (proposed | greenlit). Never trust a stored `complete`
  // over the children — and never invent `complete` for a goal with zero milestones.
  const allComplete = milestones.length > 0 && row.milestones.every((m) => m.status === "complete");
  const status: GoalStatus = allComplete ? "complete" : dbGoalRowStatus(row.status);
  return {
    slug: row.slug,
    title: row.title,
    outcome: row.outcome ?? "",
    successMetric: row.success_metric ?? "",
    target: targetFromBody(row.body),
    owner: row.owner || undefined,
    status,
    proposedBy: row.proposer_function || undefined,
    milestones,
    pct,
    linkedSpecCount,
  };
}

/** Resolve each milestone of a goal to its linked SpecCards, keyed by milestone id. Reads child specs via
 *  the specs-table SDK (`specsForMilestone`) and maps them to SpecCards from the already-loaded board set
 *  (so completion mirrors the board exactly), falling back to a fresh DB read for any not on the board. */
async function specsByMilestoneForGoals(workspaceId: string, goals: GoalRow[], board: SpecCard[]): Promise<Map<string, SpecCard[]>> {
  const bySlug = new Map(board.map((c) => [c.slug, c]));
  const out = new Map<string, SpecCard[]>();
  const milestoneIds = goals.flatMap((g) => g.milestones.map((m) => m.id));
  await Promise.all(
    milestoneIds.map(async (mid) => {
      const rows = await specsForMilestone(workspaceId, mid);
      // Prefer the board's already-resolved SpecCard (carries blocker resolution + card-state overlay);
      // fall back to a fresh map of the raw row for any spec not boardable (e.g. folded — excluded above).
      const cards = rows
        .filter((r) => isBoardableStatus(r.status))
        .map((r) => bySlug.get(r.slug) ?? dbRowToSpecCard(r));
      out.set(mid, cards);
    }),
  );
  return out;
}

async function readMdSlugs(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

export async function listFunctionSlugs(): Promise<string[]> {
  return readMdSlugs(FUNCTIONS_DIR);
}

/** Slugs of every active goal — DB-driven (no fs read). Folded goals are off the active board, so they're
 *  filtered out. No-arg callers resolve the single-tenant workspace via the shim. */
export async function listGoalSlugs(): Promise<string[]> {
  const wsId = await resolveDefaultWorkspaceId();
  if (!wsId) return [];
  try {
    const rows = await listGoalsFromDb(wsId);
    return rows.filter((g) => g.status !== "folded").map((g) => g.slug);
  } catch {
    return [];
  }
}

export async function getFunctions(): Promise<FunctionCard[]> {
  const slugs = await listFunctionSlugs();
  const cards = await Promise.all(
    slugs.map(async (s) => parseFunction(s, await fs.readFile(path.join(FUNCTIONS_DIR, `${s}.md`), "utf8"))),
  );
  const ord = (fn: string) => {
    const i = FUNCTION_ORDER.indexOf(fn);
    return i < 0 ? 99 : i;
  };
  return cards.sort((a, b) => ord(a.slug) - ord(b.slug) || a.slug.localeCompare(b.slug));
}

/** One function: its card, raw markdown, and the live owner→parent spec groups (from getFunctionMap). */
export async function getFunction(slug: string, workspaceId?: string): Promise<{ raw: string; card: FunctionCard; group: FunctionGroup | null } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(FUNCTIONS_DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
  const card = parseFunction(slug, raw);
  const { functions } = await getFunctionMap(workspaceId);
  return { raw, card, group: functions.find((f) => f.fn === slug) ?? null };
}

/**
 * Every active goal as a `GoalCard`, read from `public.goals` + `public.goal_milestones` (the DB is the
 * full source — goal-readers-from-db-retire-parsegoal). Folded goals are dropped (declined/archived — off
 * the active board). Each goal's milestone completion + rollup % is computed from its linked specs (the
 * same `getRoadmap().specs` board set, joined by `specs.milestone_id`). Sorted by title (parity with the
 * old markdown reader).
 */
export async function getGoals(workspaceId?: string): Promise<GoalCard[]> {
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  if (!wsId) return [];
  const [{ specs }, rows] = await Promise.all([getRoadmap(wsId), listGoalsFromDb(wsId)]);
  const active = rows.filter((g) => g.status !== "folded");
  if (!active.length) return [];
  const specsByMilestone = await specsByMilestoneForGoals(wsId, active, specs);
  return active
    .map((row) => goalRowToCard(row, specsByMilestone))
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * One goal: its card (with rollup), raw markdown (now the goal's DB `body` — the detail page renders it),
 * and the resolved SpecCard for each spec linked to the goal's milestones, keyed by slug. Folded → null
 * (declined/archived). No fs read, no markdown parse.
 */
export async function getGoal(slug: string, workspaceId?: string): Promise<{ raw: string; card: GoalCard; specs: Record<string, SpecCard> } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  if (!wsId) return null;
  const row = await getGoalFromDbRow(wsId, slug);
  if (!row || row.status === "folded") return null;
  const { specs } = await getRoadmap(wsId);
  const specsByMilestone = await specsByMilestoneForGoals(wsId, [row], specs);
  const card = goalRowToCard(row, specsByMilestone);
  // The linked specs for THIS goal (across its milestones), keyed by slug — same shape the detail page
  // consumed when it filtered getRoadmap's specs to the goal.
  const bySlug: Record<string, SpecCard> = {};
  for (const list of specsByMilestone.values()) for (const s of list) bySlug[s.slug] = s;
  return { raw: row.body, card, specs: bySlug };
}

// ── Folded-goal archive readers (goal-fold-from-db-row Phase 2) ──────────────────────────────────────
// A folded goal is `public.goals.status='folded'` — off the active board (`getGoals` drops it) but
// PRESERVED in full. The board's Archive section + the goal detail page render it FROM THE ROW (the
// row is the archive; its durable knowledge also lives in the permanent brain pages it folded into).
// These readers are the only path that surfaces folded rows — every other goal reader filters them out.

/** An archived (folded) goal as a `GoalCard`, read from the preserved `public.goals` row. The card carries
 *  the goal's full shape (title, outcome, success metric, milestones, rollup %) so the archive renders it
 *  identically to its pre-fold live view. `updatedAt` is the fold timestamp (the `updated_at` bump the
 *  worker wrote when it flipped `status='folded'`). */
export interface ArchivedGoal {
  card: GoalCard;
  raw: string;
  updatedAt: string;
}

function archivedGoalFrom(row: GoalRow, specsByMilestone: Map<string, SpecCard[]>): ArchivedGoal {
  return { card: goalRowToCard(row, specsByMilestone), raw: row.body, updatedAt: row.updated_at };
}

/**
 * Every FOLDED goal as an `ArchivedGoal`, read from `public.goals` where `status='folded'` (the rows
 * `getGoals` drops). The board's Archive section reads this. Newest-fold first (by `updated_at`, the fold
 * timestamp), tie-broken by title.
 */
export async function getFoldedGoals(workspaceId?: string): Promise<ArchivedGoal[]> {
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  if (!wsId) return [];
  const [{ specs }, rows] = await Promise.all([getRoadmap(wsId), listGoalsFromDb(wsId, { status: "folded" })]);
  if (!rows.length) return [];
  const specsByMilestone = await specsByMilestoneForGoals(wsId, rows, specs);
  return rows
    .map((row) => archivedGoalFrom(row, specsByMilestone))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.card.title.localeCompare(b.card.title));
}

/**
 * One FOLDED goal by slug — the detail page renders this when `getGoal` returns null (folded). Reads the
 * preserved row directly; returns null when the goal is missing OR not folded (an active goal stays on
 * the live `getGoal` path).
 */
export async function getFoldedGoal(slug: string, workspaceId?: string): Promise<{ raw: string; card: GoalCard; specs: Record<string, SpecCard>; updatedAt: string } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  if (!wsId) return null;
  const row = await getGoalFromDbRow(wsId, slug);
  if (!row || row.status !== "folded") return null;
  const { specs } = await getRoadmap(wsId);
  const specsByMilestone = await specsByMilestoneForGoals(wsId, [row], specs);
  const card = goalRowToCard(row, specsByMilestone);
  const bySlug: Record<string, SpecCard> = {};
  for (const list of specsByMilestone.values()) for (const s of list) bySlug[s.slug] = s;
  return { raw: row.body, card, specs: bySlug, updatedAt: row.updated_at };
}

// ── Roadmap board filters: goal-membership + per-spec source (roadmap-goal-and-source-filters) ──

/** What created a spec, derived (no author tag): 🔧 repair · 🎯 goal · ✋ manual. */
export type SpecSource = "repair" | "goal" | "manual";

export interface RoadmapFilterData {
  /** Dropdown options — every active goal (public.goals row), by title. */
  goals: { slug: string; title: string }[];
  /** spec slug → goal slugs it belongs to (goal-doc wikilinks ∪ parent-match). Empty array = no goal. */
  goalsBySpec: Record<string, string[]>;
  /** spec slug → its derived source. */
  sourceBySpec: Record<string, SpecSource>;
}

/** Does a spec's (cleaned) parent string reference this goal — its slug, title, or a milestone of it? */
function parentReferencesGoal(parent: string | undefined, goal: { slug: string; title: string; milestoneNames: string[] }): boolean {
  if (!parent) return false;
  const p = parent.toLowerCase();
  const slug = goal.slug.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The Parent line's [[../goals/{slug}]] wikilink survives cleanInline as a "../goals/{slug}" path token.
  if (new RegExp(`(^|[\\s/[(])${slug}(\\b|$)`).test(p)) return true;
  if (goal.title && p.includes(goal.title.toLowerCase())) return true;
  // Milestone reference, e.g. **Parent:** M2 — Lever-importance model + CRO-learnings memory.
  return goal.milestoneNames.some((n) => n.length >= 5 && p.includes(n.toLowerCase()));
}

/**
 * Resolve goal→spec membership + per-spec source for the roadmap board's filters, once per render. Goals
 * are read from `public.goals` (goal-readers-from-db-retire-parsegoal). Membership = the union of (a) the
 * specs ATTACHED to one of the goal's milestones (`specs.milestone_id` join — the strong, DB-native
 * planner signal that replaced goal-doc wikilinks) ∪ any residual `[[spec-slug]]` wikilinks left in the
 * goal's `body`, and (b) specs whose **Parent:** references the goal (its slug, title, or a milestone).
 * Source = 🔧 repair if the spec carries a Repair-signature, else 🎯 goal if it's attached/wikilinked (the
 * planner/goal-milestone signal — not parent-match alone), else ✋ manual.
 */
export async function getRoadmapFilters(workspaceId?: string): Promise<RoadmapFilterData> {
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  if (!wsId) return { goals: [], goalsBySpec: {}, sourceBySpec: {} };
  const [{ specs }, rows] = await Promise.all([getRoadmap(wsId), listGoalsFromDb(wsId)]);
  const active = rows.filter((g) => g.status !== "folded");
  const specsByMilestone = await specsByMilestoneForGoals(wsId, active, specs);
  const goalDocs = active.map((row) => {
    // Strong signal: every spec attached to one of the goal's milestones (specs.milestone_id) PLUS any
    // residual [[spec-slug]] wikilinks still in the goal body. This union is the "goal" source set.
    const attached = new Set<string>();
    for (const m of row.milestones) for (const s of specsByMilestone.get(m.id) ?? []) attached.add(s.slug);
    for (const s of specWikilinks(row.body)) attached.add(s);
    return {
      slug: row.slug,
      title: row.title,
      linked: attached,
      milestoneNames: row.milestones.map((m) => cleanInline(m.title)).filter(Boolean),
    };
  });

  const goalsBySpec: Record<string, string[]> = {};
  const sourceBySpec: Record<string, SpecSource> = {};
  for (const spec of specs) {
    const linkedGoals = goalDocs.filter((g) => g.linked.has(spec.slug));
    const memberGoals = goalDocs.filter(
      (g) => g.linked.has(spec.slug) || parentReferencesGoal(spec.parent, g),
    );
    goalsBySpec[spec.slug] = memberGoals.map((g) => g.slug);
    sourceBySpec[spec.slug] = spec.repairSignature ? "repair" : linkedGoals.length ? "goal" : "manual";
  }

  return {
    goals: goalDocs
      .map((g) => ({ slug: g.slug, title: g.title }))
      .sort((a, b) => a.title.localeCompare(b.title)),
    goalsBySpec,
    sourceBySpec,
  };
}
