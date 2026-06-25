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
 * The project-tracks header (`## Active project …` in `specs/README.md`) + the goals/functions/
 * archive readers below are NOT in this phase's scope — they stay file-backed until
 * [[goal-readers-from-db-retire-parsegoal]] cuts over. That's why `next.config.ts` still traces
 * the goals/functions/archive markdown into the roadmap routes — Phase 4 only drops the
 * specs entries from outputFileTracingIncludes.
 */
import { promises as fs } from "fs";
import path from "path";
import { listSpecs as listSpecsFromDb, getSpec as getSpecFromDb, type SpecRow, type SpecPhaseRow } from "@/lib/specs-table";
import { listGoals as listGoalsFromDb, getGoal as getGoalRowFromDb, type GoalRow, type GoalMilestoneRow } from "@/lib/goals-table";

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

export interface ProjectTrack {
  title: string;
  status: Phase;
  why: string;
  specSlugs: string[];
}

export interface RoadmapData {
  tracks: ProjectTrack[];
  specs: SpecCard[];
}

const SPECS_DIR = path.join(process.cwd(), "docs", "brain", "specs");
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

function parseTracks(raw: string): ProjectTrack[] {
  const lines = raw.split("\n");
  const tracks: ProjectTrack[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(Active project.*)/);
    if (!m) continue;
    const title = cleanInline(m[1]);
    const status = statusFromText(lines[i]) ?? "planned";
    let why = "";
    const specSlugs: string[] = [];
    for (let j = i + 1; j < lines.length && !lines[j].startsWith("## "); j++) {
      const t = lines[j].trim();
      const sm = t.match(/\*\*(?:Spec|Lifecycle):\*\*\s*(.*)/);
      if (sm) {
        for (const wl of sm[1].matchAll(/\[\[([^\]|]+)/g)) specSlugs.push(wl[1].replace(/^\.\.\//, ""));
      }
      const wm = t.match(/\*\*Why this matters:\*\*\s*(.*)/);
      if (wm && !why) why = cleanInline(wm[1]);
    }
    tracks.push({ title, status, why, specSlugs });
  }
  return tracks;
}

/** Parse + resolve + sort a slug→raw map into board-ready cards (source-agnostic: git or fs). */
function buildSpecCards(rawBySlug: Map<string, string>): SpecCard[] {
  const cards = [...rawBySlug.entries()].map(([slug, raw]) => parseSpec(slug, raw));
  // Resolve every spec's Blocked-by slugs against the live set, so the board + the enqueue gate share one
  // source of truth for cleared/uncleared (spec-blockers). A blocker not in this map = archived/folded ⇒ cleared.
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  for (const c of cards) c.blockedBy = resolveBlockedBy(c, bySlug);
  // newest-feeling first: in-progress, then in-review (awaiting approval), then planned, then shipped, then deferred (parked); stable by title
  const rank: Record<SpecStatus, number> = { in_progress: 0, in_review: 1, planned: 2, shipped: 3, deferred: 4, rejected: 5 };
  return cards.sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title));
}

async function readSpecs(): Promise<SpecCard[]> {
  let files: string[];
  try {
    files = await fs.readdir(SPECS_DIR);
  } catch {
    return [];
  }
  const rawBySlug = new Map<string, string>();
  await Promise.all(
    files
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map(async (f) => rawBySlug.set(f.replace(/\.md$/, ""), await fs.readFile(path.join(SPECS_DIR, f), "utf8"))),
  );
  return buildSpecCards(rawBySlug);
}

async function readTracks(): Promise<ProjectTrack[]> {
  try {
    return parseTracks(await fs.readFile(path.join(SPECS_DIR, "README.md"), "utf8"));
  } catch {
    return [];
  }
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
    status: dbStatusToSpecStatus(row.status),
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
  const tracks = await readTracks();
  return { specs, tracks };
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
const GOALS_DIR = path.join(process.cwd(), "docs", "brain", "goals");

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

/** Derive a goal's lifecycle state from its `**Status:**` line (if any) + its rollup %. An explicit
 * marker always wins; with no marker a legacy goal is `complete` at 100%, else `greenlit` (active). Only an
 * explicit `Status: proposed` yields `proposed` — so a proposed 0% goal never collides with an active 0% one. */
export function deriveGoalStatus(rawStatus: string, pct: number): GoalStatus {
  const s = rawStatus.trim().toLowerCase();
  if (s.startsWith("propose")) return "proposed";
  if (s.startsWith("complete") || s.startsWith("done") || s.startsWith("shipped")) return "complete";
  if (s.startsWith("greenlit") || s.startsWith("greenlight") || s === "active" || s.startsWith("in progress") || s.startsWith("in_progress")) return "greenlit";
  return pct >= 100 ? "complete" : "greenlit"; // no explicit marker ⇒ legacy CEO goal (active)
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

/** Build a slug → completion lookup once for rollups. */
function completionMap(specs: SpecCard[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of specs) m.set(s.slug, specCompletion(s));
  return m;
}

export function parseGoal(slug: string, raw: string, specs: SpecCard[] = []): GoalCard {
  const lines = raw.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? cleanInline(titleLine.slice(2)) : functionLabel(slug);

  const meta = (label: string): string => {
    const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*(.+)`, "i");
    for (const l of lines) {
      const m = l.match(re);
      if (m) return cleanInline(m[1]);
    }
    return "";
  };

  // Owner (the DRI function) from the `Owner: [[../functions/x]]` line under "## Ownership & mirrors" —
  // bold or plain, anywhere in the doc. This is the canonical goal→function link (the function doc's
  // "Owned goals" prose list isn't reliably wikilinked); the Platform/DevOps Director escort selects the
  // goals it owns by this (platform-director-agent Phase 2).
  let owner: string | undefined;
  for (const l of lines) {
    const m = l.match(/(?:\*\*)?Owner:?(?:\*\*)?\s*\[\[([^\]|]+)/i);
    if (m) {
      owner = m[1].trim().replace(/^.*\//, "").replace(/\.md$/, "");
      break;
    }
  }

  // Proposed-by (director-proposed-goals): the function slug that AUTHORED this goal as a proposal. Present
  // only on a director-proposed artifact; absent on a CEO-authored goal. Drives the hub's proposer badge.
  let proposedBy: string | undefined;
  for (const l of lines) {
    const m = l.match(/\*\*Proposed-by:\*\*\s*\[\[([^\]|]+)/i);
    if (m) {
      proposedBy = m[1].trim().replace(/^.*\//, "").replace(/\.md$/, "");
      break;
    }
  }

  // Milestones: top-level "- " bullets under "## Decomposition", each with its trailing lines.
  const decomp = sectionLines(lines, /^##\s+Decomposition/i);
  const milestones: Milestone[] = [];
  let block: string[] = [];
  const flush = () => {
    if (!block.length) return;
    const text = block.join("\n");
    const idm = text.match(/\*\*\s*(M\d+)\b/);
    const namem = text.match(/\*\*\s*(?:M\d+\s*[—–-]\s*)?([^*]+?)\.?\s*\*\*/);
    const metricm = text.match(/\*\*Metric:\*\*\s*([^\n]+)/i);
    const specSlugs = [...new Set(specWikilinks(text))];
    milestones.push({
      id: idm ? idm[1] : "",
      name: cleanInline(namem ? namem[1] : text.split("\n")[0].replace(/^[-*]\s*/, "")),
      status: statusFromText(text) ?? "planned",
      metric: metricm ? cleanInline(metricm[1]) : undefined,
      specSlugs,
      completion: 0,
    });
    block = [];
  };
  for (const l of decomp) {
    if (/^[-*]\s/.test(l)) {
      flush();
      block = [l];
    } else if (block.length) {
      block.push(l);
    }
  }
  flush();

  // Rollup: each milestone's completion = avg of its linked specs' completion; if none linked,
  // fall back to its own emoji (shipped ⇒ 1). Goal % = mean of milestone completions.
  const comp = completionMap(specs);
  let linkedSpecCount = 0;
  for (const m of milestones) {
    const resolved = m.specSlugs.map((s) => comp.get(s)).filter((v): v is number => v != null);
    linkedSpecCount += resolved.length;
    m.completion = resolved.length ? resolved.reduce((a, b) => a + b, 0) / resolved.length : m.status === "shipped" ? 1 : 0;
  }
  const pct = milestones.length ? Math.round((milestones.reduce((a, m) => a + m.completion, 0) / milestones.length) * 100) : 0;

  return {
    slug,
    title,
    outcome: meta("Outcome"),
    successMetric: meta("Success metric"),
    target: meta("Target"),
    owner,
    status: deriveGoalStatus(meta("Status"), pct),
    proposedBy,
    milestones,
    pct,
    linkedSpecCount,
  };
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
export async function listGoalSlugs(): Promise<string[]> {
  return readMdSlugs(GOALS_DIR);
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
 * goal-greenlight-button-and-author-writes-db Phase 3 — overlay the DB row's `status` onto the
 * parsed-markdown GoalCard, so every reader (the goals board, /api/roadmap/plan, escortApprovedGoals,
 * agents hub) decides off `public.goals.status` instead of the `**Status:**` markdown line. Until the
 * Phase 4 mirror-md commit lands, the row IS the truth: a Greenlight click flips the row in <100ms
 * and every surface sees it, no commit / deploy required.
 *
 * Transitional safety: a missing `goals` table (the [[goals-milestones-tables-and-backfill]]
 * migration hasn't applied yet) or an empty backfill is swallowed — the markdown's parsed `status`
 * stays. Folded rows are filtered (a declined goal is gone from the active board, mirroring the
 * pre-cutover "Decline → delete .md" behavior).
 */
async function loadGoalStatusOverlay(workspaceId?: string): Promise<Map<string, GoalStatus | "folded">> {
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  if (!wsId) return new Map();
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("goals")
      .select("slug, status")
      .eq("workspace_id", wsId);
    if (error || !data) return new Map();
    const out = new Map<string, GoalStatus | "folded">();
    for (const r of data as { slug: string; status: GoalStatus | "folded" }[]) {
      out.set(r.slug, r.status);
    }
    return out;
  } catch {
    return new Map();
  }
}

/** Translate a goals-row status to GoalCard.status, or null when the row is folded (caller filters). */
function dbGoalStatusToCardStatus(s: GoalStatus | "folded" | undefined): GoalStatus | null {
  if (!s) return null;
  if (s === "folded") return null;
  return s;
}

export async function getGoals(workspaceId?: string): Promise<GoalCard[]> {
  const [{ specs }, slugs, statusOverlay] = await Promise.all([
    getRoadmap(workspaceId),
    listGoalSlugs(),
    loadGoalStatusOverlay(workspaceId),
  ]);
  const cards = await Promise.all(
    slugs.map(async (s) => parseGoal(s, await fs.readFile(path.join(GOALS_DIR, `${s}.md`), "utf8"), specs)),
  );
  const overlaid: GoalCard[] = [];
  for (const card of cards) {
    const row = statusOverlay.get(card.slug);
    if (row === "folded") continue; // folded row = declined/archived; off the active board
    const dbStatus = dbGoalStatusToCardStatus(row);
    overlaid.push(dbStatus ? { ...card, status: dbStatus } : card);
  }
  return overlaid.sort((a, b) => a.title.localeCompare(b.title));
}

/** One goal: card (with rollup), raw markdown, and the resolved SpecCard for each linked milestone spec. */
export async function getGoal(slug: string, workspaceId?: string): Promise<{ raw: string; card: GoalCard; specs: Record<string, SpecCard> } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(GOALS_DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
  const [{ specs }, statusOverlay] = await Promise.all([
    getRoadmap(workspaceId),
    loadGoalStatusOverlay(workspaceId),
  ]);
  let card = parseGoal(slug, raw, specs);
  const row = statusOverlay.get(slug);
  if (row === "folded") return null;
  const dbStatus = dbGoalStatusToCardStatus(row);
  if (dbStatus) card = { ...card, status: dbStatus };
  const bySlug: Record<string, SpecCard> = {};
  for (const s of specs) bySlug[s.slug] = s;
  return { raw, card, specs: bySlug };
}

// ──────────────────────────────────────────────────────────────────────────────
// DB-first goal readers (goal-readers-from-db-retire-parsegoal Phase 1)
//
// These mirror the spec-side readers introduced in
// [[spec-readers-from-db-retire-parser]]: read `public.goals` + `public.goal_milestones` (joined
// by `goals-table.listGoals` / `getGoal`) and shape them into the same `GoalCard` / return type
// every existing markdown consumer compiles against. The GoalCard shape is stable — only the
// SOURCE flips. Phase 2 swaps every reader surface from the markdown `getGoals`/`getGoal` to
// these; Phase 3 deletes the markdown parser + the loadGoalStatusOverlay shim.
//
// Per-milestone progress: each `goal_milestones.id` is matched against `specs.milestone_id` to
// resolve its child specs (the per-spec `parent` text is NOT consulted — milestone_id is the
// canonical link now). For the `getGoalFromDb` `specs` field we additionally include any spec
// whose `parent` text references the goal (slug/title/milestone) but whose `milestone_id IS
// NULL` — the legacy / standalone bucket the spec calls out. The rollup % matches the markdown
// path: each milestone's completion is the avg of its linked specs' completion (fallback to
// the milestone's own status when no specs are linked); the goal's pct is the mean over
// milestones × 100.
// ──────────────────────────────────────────────────────────────────────────────

/** Map a DB `goal_milestones.status` (planned|in_progress|complete) → the `Phase` enum the
 *  GoalCard.milestone surface uses (planned|in_progress|shipped|rejected). `complete` → shipped. */
function dbMilestoneStatusToPhase(s: GoalMilestoneRow["status"]): Phase {
  if (s === "complete") return "shipped";
  if (s === "in_progress") return "in_progress";
  return "planned";
}

/** Coerce a DB `goals.status` (proposed|greenlit|complete|folded) to the GoalCard `GoalStatus`
 *  surface (proposed|greenlit|complete). Folded rows are filtered by the caller (a folded goal
 *  is off the active board, mirroring the pre-cutover `Decline → delete .md` behavior). */
function dbGoalRowStatusToCard(s: GoalRow["status"]): GoalStatus | null {
  if (s === "folded") return null;
  return s;
}

/** Lift "M1" / "M2" / … out of a milestone title like "M1 — Lever-importance model". Matches the
 *  shape the backfill writes (`backfill-goals-from-markdown.ts`: `title: card.milestone.id ? id +
 *  " — " + name : name`) and what `parseGoal`'s regex `/^\*\*\s*(M\d+)\b/` produced. Empty
 *  string when the title carries no Mn marker (matches `parseGoal`). */
function milestoneIdFromTitle(title: string): string {
  const m = title.match(/^\s*(M\d+)\b/);
  return m ? m[1] : "";
}

/** Strip a leading "M1 — " prefix from a milestone title to recover the bare name (the value the
 *  markdown `parseGoal` stored on `Milestone.name`). */
function milestoneNameFromTitle(title: string): string {
  return cleanInline(title.replace(/^\s*M\d+\s*[—–-]\s*/, ""));
}

/** Build the GoalCard.milestones array for a DB row, given a pre-built `milestone_id → SpecCard[]`
 *  index. Each milestone's `completion` is the avg of its linked specs' completion (fallback to
 *  the milestone's own status — complete=1, in_progress=0.5, planned=0 — when no specs link).
 *  Returned alongside the totals the caller needs for `pct` + `linkedSpecCount`. */
function buildGoalMilestones(
  rows: GoalMilestoneRow[],
  specsByMilestone: Map<string, SpecCard[]>,
): { milestones: Milestone[]; pct: number; linkedSpecCount: number } {
  const milestones: Milestone[] = rows.map((m) => {
    const linked = specsByMilestone.get(m.id) ?? [];
    const completions = linked.map(specCompletion);
    const status = dbMilestoneStatusToPhase(m.status);
    const completion = completions.length
      ? completions.reduce((a, b) => a + b, 0) / completions.length
      : status === "shipped"
        ? 1
        : status === "in_progress"
          ? 0.5
          : 0;
    return {
      id: milestoneIdFromTitle(m.title),
      name: milestoneNameFromTitle(m.title),
      status,
      metric: undefined,
      specSlugs: linked.map((s) => s.slug),
      completion,
    };
  });
  const linkedSpecCount = milestones.reduce((acc, m) => acc + m.specSlugs.length, 0);
  const pct = milestones.length
    ? Math.round((milestones.reduce((a, m) => a + m.completion, 0) / milestones.length) * 100)
    : 0;
  return { milestones, pct, linkedSpecCount };
}

/** Shape a DB GoalRow into a GoalCard, using a pre-built `milestone_id → SpecCard[]` index for
 *  per-milestone rollup. The caller filters folded rows before calling (they're off the board). */
function dbRowToGoalCard(row: GoalRow, specsByMilestone: Map<string, SpecCard[]>): GoalCard {
  const { milestones, pct, linkedSpecCount } = buildGoalMilestones(row.milestones, specsByMilestone);
  return {
    slug: row.slug,
    title: row.title,
    outcome: row.outcome ?? "",
    successMetric: row.success_metric ?? "",
    target: "", // `goals` row carries no `target` column; the markdown shape was rarely populated.
    owner: row.owner || undefined,
    status: (dbGoalRowStatusToCard(row.status) ?? "greenlit") as GoalStatus,
    proposedBy: row.proposer_function ?? undefined,
    milestones,
    pct,
    linkedSpecCount,
  };
}

/** Build a `milestone_id → SpecCard[]` index by walking the workspace's spec ROWS once (the
 *  SpecCard surface drops `milestone_id`, but we already have the rows from `listSpecsFromDb` in
 *  the DB-first path). Returns the index plus the SpecCard array (re-built from the same rows so
 *  consumers stay on the canonical shape). */
async function readSpecsAndMilestoneIndex(workspaceId: string): Promise<{
  specs: SpecCard[];
  specsByMilestone: Map<string, SpecCard[]>;
  specRowBySlug: Map<string, SpecRow>;
}> {
  const rows = (await listSpecsFromDb(workspaceId)).filter((r) => isBoardableStatus(r.status));
  const cards = rows.map(dbRowToSpecCard);
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  for (const c of cards) c.blockedBy = resolveBlockedBy(c, bySlug);
  // milestone_id → SpecCard[] (only specs that ARE attached to a milestone; standalone specs are
  // un-grouped here and surface via the parent-text fallback in `getGoalFromDb`).
  const specsByMilestone = new Map<string, SpecCard[]>();
  const specRowBySlug = new Map<string, SpecRow>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    specRowBySlug.set(r.slug, r);
    if (!r.milestone_id) continue;
    const list = specsByMilestone.get(r.milestone_id) ?? [];
    list.push(cards[i]);
    specsByMilestone.set(r.milestone_id, list);
  }
  return { specs: cards, specsByMilestone, specRowBySlug };
}

/**
 * Every goal in a workspace, DB-first. Folded goals are filtered (off the active board, matching
 * the markdown-path behavior `Decline → delete .md`). Sorted by title for the same order the
 * existing `getGoals` returns. The legacy no-arg call site uses `resolveDefaultWorkspaceId()`.
 */
export async function getGoalsFromDb(workspaceId?: string): Promise<GoalCard[]> {
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  if (!wsId) return [];
  const [goalRows, { specsByMilestone }] = await Promise.all([
    listGoalsFromDb(wsId),
    readSpecsAndMilestoneIndex(wsId),
  ]);
  const cards: GoalCard[] = [];
  for (const row of goalRows) {
    if (row.status === "folded") continue; // off the active board
    cards.push(dbRowToGoalCard(row, specsByMilestone));
  }
  return cards.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * One goal, DB-first. Returns `{ raw, card, specs }` matching the existing markdown `getGoal` so
 * Phase 2 callers swap in place. `raw` is the `goals.body` column (the backfill stores the FULL
 * markdown so callers like the goal detail page can render via `marked.parse` without disk I/O).
 * The `specs` map covers (a) every spec attached to one of this goal's milestones via
 * `specs.milestone_id`, plus (b) any spec whose `parent` text references the goal but has
 * `milestone_id IS NULL` (the legacy / standalone bucket the spec calls out). Folded goal → null.
 */
export async function getGoalFromDb(
  slug: string,
  workspaceId?: string,
): Promise<{ raw: string; card: GoalCard; specs: Record<string, SpecCard> } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  if (!wsId) return null;
  const [row, { specs, specsByMilestone, specRowBySlug }] = await Promise.all([
    getGoalRowFromDb(wsId, slug),
    readSpecsAndMilestoneIndex(wsId),
  ]);
  if (!row || row.status === "folded") return null;

  const card = dbRowToGoalCard(row, specsByMilestone);

  // Resolve the `specs` map: every spec attached to one of this goal's milestones, PLUS any
  // standalone spec whose `parent` text references this goal (slug / title / milestone name) but
  // whose `milestone_id IS NULL` (the legacy bucket the spec calls out).
  const goalForMatch = { slug: row.slug, title: row.title, milestoneNames: card.milestones.map((m) => m.name).filter(Boolean) };
  const bySlug: Record<string, SpecCard> = {};
  for (const m of row.milestones) {
    for (const s of specsByMilestone.get(m.id) ?? []) bySlug[s.slug] = s;
  }
  for (const s of specs) {
    if (bySlug[s.slug]) continue;
    const r = specRowBySlug.get(s.slug);
    if (!r || r.milestone_id) continue; // attached specs already covered above
    if (parentReferencesGoal(s.parent, goalForMatch)) bySlug[s.slug] = s;
  }

  return { raw: row.body ?? "", card, specs: bySlug };
}

/** Slugs of every non-folded goal in a workspace, DB-first. The no-arg call site uses
 *  `resolveDefaultWorkspaceId()` to match the legacy `listGoalSlugs()` shape. */
export async function listGoalSlugsFromDb(workspaceId?: string): Promise<string[]> {
  const wsId = workspaceId ?? (await resolveDefaultWorkspaceId());
  if (!wsId) return [];
  const rows = await listGoalsFromDb(wsId);
  return rows.filter((r) => r.status !== "folded").map((r) => r.slug).sort();
}

// ── Roadmap board filters: goal-membership + per-spec source (roadmap-goal-and-source-filters) ──

/** What created a spec, derived (no author tag): 🔧 repair · 🎯 goal · ✋ manual. */
export type SpecSource = "repair" | "goal" | "manual";

export interface RoadmapFilterData {
  /** Dropdown options — every docs/brain/goals/*.md, by title. */
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
 * Resolve goal→spec membership + per-spec source for the roadmap board's filters, once per render.
 * Membership = the union of (a) each goal doc's [[spec-slug]] wikilinks (the reliable planner signal) and
 * (b) specs whose **Parent:** references the goal (its slug, title, or a milestone). Source = 🔧 repair if
 * the spec carries a **Repair-signature:** line, else 🎯 goal if it's wikilinked from a goal doc (the
 * planner/goal-milestone signal — wikilink only, not parent-match), else ✋ manual. No schema change.
 */
export async function getRoadmapFilters(workspaceId?: string): Promise<RoadmapFilterData> {
  const [{ specs }, goalSlugs] = await Promise.all([getRoadmap(workspaceId), listGoalSlugs()]);
  const goalDocs = await Promise.all(
    goalSlugs.map(async (slug) => {
      const raw = await fs.readFile(path.join(GOALS_DIR, `${slug}.md`), "utf8");
      const card = parseGoal(slug, raw, specs);
      return {
        slug,
        title: card.title,
        // Every spec the goal doc wikilinks anywhere (milestones + prose) — the primary membership signal.
        wikilinked: new Set(specWikilinks(raw)),
        milestoneNames: card.milestones.map((m) => m.name).filter(Boolean),
      };
    }),
  );

  const goalsBySpec: Record<string, string[]> = {};
  const sourceBySpec: Record<string, SpecSource> = {};
  for (const spec of specs) {
    const linkedGoals = goalDocs.filter((g) => g.wikilinked.has(spec.slug));
    const memberGoals = goalDocs.filter(
      (g) => g.wikilinked.has(spec.slug) || parentReferencesGoal(spec.parent, g),
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
