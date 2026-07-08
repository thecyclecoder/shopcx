/**
 * Brain roadmap reader — the source of truth for SpecCard rendering on the /dashboard/roadmap
 * board, the spec detail page, the Slack roadmap surfaces, and every script/agent that asks
 * "what's the state of spec X."
 *
 * spec-readers-from-db-retire-parser (2026-06-25/26): every SPEC read comes from `public.specs` +
 * `public.spec_phases` via `readSpecsFromDb(workspaceId)` — the DB row IS the truth. Phase 3 RETIRED the
 * read-side overlay/merge: `overlayDbStateOnSpec` + `spec-card-state.mergePhaseStates` are gone (the
 * card is built straight from the DB rows, per-phase pr/merge_sha included). `parseSpec` is no longer on
 * any READER path (getRoadmap/getSpec/listSpecSlugs are pure-DB); it survives ONLY as the markdown→card
 * AUTHORING parser (`author-spec.authorSpecRowFromMarkdown`) + the `deriveSpecStatus(raw)` would-this-fold
 * helper ([[platform-director]]) — both write/check paths, not board reads.
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
// goal-promotion-fold-collision-and-held-surfacing Phase 2 — pure predicate for the HELD promotion surface.
// One-truth-per-derivation: `promoteCompleteGoalsToMain` writes the state, this reader derives the badge.
import { deriveGoalPromotionSurface } from "@/lib/goal-promotion-surface";
// one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec Phase 1 — outside-dependent
// blocker normalization. Pure; the wire-up in `resolveBlockedBy` supplies the workspace's goal-membership
// index (spec slug → goal + goal.main_merge_sha) once per workspace read.
import { deriveEffectiveBlockers, type GoalMembership } from "@/lib/blocker-goal-normalize";
// escort-reliably-dispatches-ready-goal-members Phase 1 — the trust boundary for "is this blocker cleared?"
// A goal-mate blocker clears the instant it lands on the goal branch (goal_branch_sha stamped) — the derived
// card status stays "in_progress" until the whole goal ships to main, so keying on `target.status==='shipped'`
// stalled every goal-mate dependent forever.
import { isCardShippedByPhaseProvenance, isCardAccumulatedOnGoalBranch } from "@/lib/spec-phase-provenance";

export type Phase = "planned" | "in_progress" | "shipped" | "rejected";

// A spec's WHOLE-spec board status. `deferred` is a first-class status orthogonal to phase progress
// (director-drives-all-specs-and-deferred-status Phase 1): a spec the board parks in its OWN column,
// excluded by every auto-build lane until the CEO un-defers it. Phases themselves are never `deferred`
// (no phase emoji maps to it) — only a SpecCard is, so `SpecPhase.status` + `counts` stay `Phase`.
// `in_review` (spec-review-agent): a NEWLY authored spec lands here — BEFORE `planned` — and can NEVER be
// built until the Spec-Review agent (Vale) checks it against the authoring guidelines and moves it to
// `planned` or `deferred`. Its own first column on the board. Like `deferred`, it's a SpecCard status only
// (phases stay `Phase`).
// `in_testing` (preview-test-promote-pipeline M3): a card whose work is on a per-build preview deploy but
// hasn't passed BOTH the pre-merge spec-test green AND security green signals. Slots between in_progress
// and shipped. Purely DERIVED at read time (never stored on `public.specs.status` — that column carries
// only explicit lifecycle overrides: in_review / deferred / folded). The in_review / deferred / folded
// overrides still win over in_testing (they are explicit lifecycle states).
export type SpecStatus = Phase | "deferred" | "in_review" | "in_testing";

export interface SpecPhase {
  title: string;
  status: Phase;
  /** spec-status-phase-pr-provenance Phase 3: the PR # + merge SHA that SHIPPED this phase. After
   *  spec-readers-from-db-retire-parser Phase 3 these come straight off the `public.spec_phases` row
   *  (`dbRowToSpecCard`), so the board and the spec-detail page render a "P2 ✓ #519" PR chip per shipped
   *  phase (provable status) with no `spec_card_state` overlay. */
  pr?: number | null;
  merge_sha?: string | null;
  /** spec-goal-branch-pm-flow M2: the `claude/build-{slug}` spec-branch commit SHA where this phase BUILT
   *  (stampPhaseBuilt). Set when the phase builds on the branch — DISTINCT from `merge_sha`/`pr` (the M5
   *  main-promotion stamp). A phase with `build_sha` but no `pr` is built-on-branch (in_progress), the
   *  branch-flow's "this phase is done building" signal that the grooming next-phase advance reads. */
  build_sha?: string | null;
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
  //
  // one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec Phase 1 — when the raw
  // `specs.blocked_by` slug names a spec that is a MEMBER of a goal AND the dependent is NOT in that
  // goal (not a goal-mate), the effective blocker is the GOAL, not the member spec: `kind:"goal"`,
  // `slug` becomes the goal slug, `memberSpecSlug` preserves the original raw spec slug (so the
  // author-spec re-author path round-trips without collapsing to the goal). A goal-mate blocker
  // (dependent + blocker in the SAME goal) stays `kind:"spec"` — the intra-goal serializer at
  // [[agent-jobs]] `sequencePromoteCandidates` already orders it.
  blockedBy: {
    slug: string;
    title: string;
    status: Phase;
    cleared: boolean;
    kind?: "spec" | "goal";
    /** When `kind==="goal"`: the ORIGINAL raw spec slug from `specs.blocked_by`. Preserved so the
     *  author-spec re-author path can persist the original slug verbatim (Phase 1 does NOT do author-time
     *  normalization; that's an OPT-IN Vale-side change). */
    memberSpecSlug?: string;
  }[];
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
  /** spec-review-agent Phase 4 — the In Review lane surface signals (read straight off public.specs):
   *
   *   - `valePass` undefined → NEVER reviewed (fresh authoring / a send-back that NULLed the flag). "pending".
   *   - `valePass` true      → Vale's CHECKLIST cleared; the card is waiting on Ada's disposition lane.
   *   - `valePass` false     → Vale reviewed it and flagged **needs_fix** — the spec is MALFORMED and the build
   *     pipeline is hard-stopped behind it (vale-instant-per-spec-review). The board must render this distinctly
   *     from "pending" — before, `false` was collapsed to undefined here and a failed review looked unreviewed.
   *     `needsFixReason` / `needsFixDefects` carry Vale's latest diagnosis (overlaid from `director_activity`).
   *   - `adaDisposition='pending_upgrade'` → Ada parked an UPGRADE; a CEO Planned/Deferred call is queued.
   *   - `intendedStatus` is the AUTHOR'S suggested destination — surfaced inline as "↳ planned" / "↳ deferred"
   *     so the CEO can see what was proposed alongside the agent state.
   *
   * All optional — older rows / non-in_review cards carry undefined. Consumed by the In Review column on the
   * roadmap board (`InReviewLane`) and by Vale's role page; not used for status routing. */
  valePass?: boolean;
  /** vale-instant-per-spec-review — Vale's latest needs_fix diagnosis, overlaid from the most recent
   *  `director_activity` `spec_review_needs_fix` row (only populated when `valePass === false`). `needsFixReason`
   *  is her one-sentence evidence-contract verdict (shown as the chip tooltip); `needsFixDefects` is the
   *  specific checklist failures. Undefined on any non-failed card. */
  needsFixReason?: string;
  needsFixDefects?: string[];
  /** build-gate-durable-review-signal — the DURABLE "this spec passed Vale review" signal, read straight
   *  off `specs.vale_review_passed_at` (non-null → true). UNLIKE `valePass` (the transient flag Ada's
   *  disposition consumes), this survives the spec leaving in_review — so the claim-time build gate can
   *  still tell, at build time, that the spec genuinely passed review. Cleared on a send-back / re-author. */
  valeReviewPassed?: boolean;
  adaDisposition?: "autonomous_same" | "autonomous_downgrade" | "pending_upgrade";
  intendedStatus?: "planned" | "deferred";
  /** spec-goal-branch-pm-flow M6 — the branch-accumulation surface. `goalBranchSha` is the
   *  `specs.goal_branch_sha` marker M4 stamps when this spec's `claude/build-{slug}` branch merges onto its
   *  `goal/{goal}` branch; `onGoalBranch` is its boolean (true once stamped). A goal-bound spec that is
   *  `in_testing` AND `onGoalBranch` has accumulated on the goal branch and is waiting for the goal's atomic
   *  promotion to main — distinct on the board from an `in_testing` spec still sitting on its own spec branch.
   *  A one-off (no-goal) spec leaves these undefined/false; it ships straight to main on green (no goal
   *  branch). Surfaced by the board's `BranchPosition` chip. */
  goalBranchSha?: string | null;
  onGoalBranch?: boolean;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHY this spec exists. Surfaced at the top
   *  of the spec detail page (intent-first) so humans + agents both read the intent before the
   *  implementation body. Empty when the spec was authored before the intent columns landed. */
  why?: string | null;
  /** pm-structured-intent-and-refs Phase 1 — plain-language WHAT changes when this spec ships. */
  what?: string | null;
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

// pm-structured-intent-and-refs Phase 4 — renamed from `parseSpec` to make the AUTHOR-side transport
// role explicit. This is NOT a load-bearing markdown reader: the DB is the spec (readers are pure-DB
// via `readSpecsFromDb`/`getSpecFromDb`). This survives ONLY for the two AUTHOR-side transport paths
// still on markdown:
//   1. `author-spec.authorSpecRowFromMarkdown` — an agent writes a spec as markdown, we parse it once
//      to structured shape and UPSERT into `public.specs` / `public.spec_phases`. Nothing READS the
//      parsed markdown for lookups; the DB row is authoritative from that write forward.
//   2. `deriveSpecStatusFromMarkdown` — a would-this-fold check the platform-director runs against a
//      REWRITTEN parent spec's in-memory markdown (never a stored body).
// Nothing else may call this — grep shows zero readers outside those two transport paths.
export function parseAuthoredSpecMarkdown(slug: string, raw: string): SpecCard {
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
 *
 * one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec Phase 1 — accepts an
 * optional `goalByBlockerSlug` workspace-scoped index (spec slug → goal membership). When a raw blocker
 * slug names a spec that is a MEMBER of a goal AND the dependent is NOT in that same goal (not a
 * goal-mate), the entry is REWRITTEN via [[../blocker-goal-normalize]] `deriveEffectiveBlockers` so the
 * effective blocker names the GOAL (kind:"goal", slug=goalSlug, title=goalTitle, memberSpecSlug=the
 * original raw spec slug). The `cleared` predicate for a goal blocker keys on `goals.main_merge_sha`
 * (the atomic goal→main promotion marker) — a member spec ISN'T on main until the whole goal is, and
 * this predicate keeps the outside dependent's Build gate red until then. Goal-mate blockers (dependent
 * + blocker in the SAME goal) fall through to the pre-existing spec-slug path — the intra-goal
 * serializer at [[../agent-jobs]] `sequencePromoteCandidates` handles them.
 *
 * When `goalByBlockerSlug` is omitted (older/single-slug caller paths), the outside-dependent
 * normalization is INERT — every entry stays a `kind:"spec"` blocker with the pre-Phase-1 behavior.
 */
function resolveBlockedBy(
  card: SpecCard,
  bySlug: Map<string, SpecCard>,
  goalByBlockerSlug?: ReadonlyMap<string, import("@/lib/blocker-goal-normalize").GoalMembership>,
): SpecCard["blockedBy"] {
  const map = goalByBlockerSlug ?? new Map<string, import("@/lib/blocker-goal-normalize").GoalMembership>();
  const dependent = {
    slug: card.slug,
    // The dependent's OWN goal (null when it's a standalone / outside-of-goal spec). Read from the
    // same workspace-scoped map — a goal-member card carries its own goal entry.
    goalSlug: map.get(card.slug)?.goalSlug ?? null,
  };
  const rawSlugs = card.blockedBy.map((b) => b.slug);
  const effective = deriveEffectiveBlockers(rawSlugs, dependent, map);
  return effective.map((eff) => {
    if (eff.kind === "goal") {
      // The goal blocker: `cleared` iff `goals.main_merge_sha` is set (atomic goal→main promotion
      // happened). Rendered status mirrors that predicate — `shipped` after the promotion, `planned`
      // (⏳) while still off main.
      const cleared = !!eff.mainMergeSha;
      return {
        slug: eff.slug,
        title: eff.title,
        status: cleared ? ("shipped" as Phase) : ("planned" as Phase),
        cleared,
        kind: "goal" as const,
        memberSpecSlug: eff.memberSpecSlug,
      };
    }
    const target = bySlug.get(eff.slug);
    if (target) {
      // A deferred / in-review / in-testing prerequisite hasn't shipped → still blocking; show it as ⏳
      // (the chip cares shipped-or-not). `in_testing` is a derived board state that means "work is on a
      // preview, awaiting both-green + promote" — still pre-ship, so the blocker stays uncleared.
      const status: Phase =
        target.status === "deferred" || target.status === "in_review" || target.status === "in_testing"
          ? "planned"
          : target.status;
      // escort-reliably-dispatches-ready-goal-members Phase 1 — the cleared predicate is grounded in the
      // spec-phase-provenance trust boundary, NOT the derived card status:
      //   1. Truly-shipped-by-provenance (every non-rejected phase has pr OR merge_sha, or the one-shot
      //      card-level shippedPr is set) — cleared for ANY dependent, goal-mate or not.
      //   2. Goal-mate ordering — dependent + blocker in the SAME goal AND blocker landed on the goal
      //      branch (specs.goal_branch_sha stamped): cleared even though the derived card.status stays
      //      "in_progress" until the whole goal ships to main. This is the exact gap the observed 2026-07-08
      //      stall exposed — shadow-mode's spec branch merged into goal/autonomous-media-buyer-supervision
      //      (goal_branch_sha stamped) but its goal-mate dependents (daily-cadence-cron / director-slack-digest)
      //      never dispatched because the old `target.status === "shipped"` predicate demanded main-merge.
      // Outside-of-goal dependents keep waiting for the atomic goal→main promotion — handled by the
      // `kind:"goal"` branch above (predicate on `goals.main_merge_sha`), so this fallback never fires there.
      const targetGoalSlug = map.get(eff.slug)?.goalSlug ?? null;
      const isGoalMate = dependent.goalSlug !== null && dependent.goalSlug === targetGoalSlug;
      const cleared =
        isCardShippedByPhaseProvenance(target) ||
        (isGoalMate && isCardAccumulatedOnGoalBranch(target));
      return {
        slug: eff.slug,
        title: target.title,
        status,
        cleared,
        kind: "spec" as const,
      };
    }
    // Not a live spec → archived/folded (the prereq shipped + was retired into the brain) or a dangling
    // slug. Either way treat it as cleared so a Blocked-by pointing at an already-shipped/archived spec
    // never permanently blocks.
    return {
      slug: eff.slug,
      title: eff.slug,
      status: "shipped" as Phase,
      cleared: true,
      kind: "spec" as const,
    };
  });
}

// spec-readers-from-db-retire-parser Phase 3: `overlayDbStateOnSpec` is RETIRED. It overlaid the
// `spec_card_state` mirror onto a markdown-parsed SpecCard; the DB-first readers below build the card
// straight from `public.specs` + `public.spec_phases` (`dbRowToSpecCard`), so there's no markdown card to
// overlay. The only transient `spec_card_state.flags` signals that aren't on `public.specs` yet
// (short_circuit / one-shot merged_pr) are surfaced by `overlayCardFlags` instead.

/**
 * one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec Phase 1 — build the
 * workspace-scoped goal-membership index (spec slug → owning goal + `goals.main_merge_sha`) the
 * blocker normalizer at [[../blocker-goal-normalize]] reads. One `listGoals` (goals + milestones in a
 * pair of queries) plus a milestone-id → goal lookup over the spec rows we already loaded — no extra
 * per-spec I/O. Only goal-MEMBER specs appear in the map (standalone / no-milestone specs are absent,
 * which the normalizer treats as "not a goal-member" — correct).
 *
 * Best-effort: a read failure yields an empty map. The normalizer then leaves every blocker as
 * `kind:"spec"` (pre-Phase-1 behavior) — the board still renders and the enqueue gate still refuses
 * uncleared spec blockers, so an outage never wedges the pipeline; it only degrades the outside-
 * dependent goal rewrite to a spec rewrite for the duration of the outage.
 */
async function buildGoalMembershipMap(
  workspaceId: string,
  specRows: SpecRow[],
): Promise<ReadonlyMap<string, GoalMembership>> {
  try {
    const goals = await listGoalsFromDb(workspaceId);
    if (!goals.length) return new Map<string, GoalMembership>();
    // milestone id → owning goal
    const goalByMilestoneId = new Map<string, { slug: string; title: string; mainMergeSha: string | null }>();
    for (const g of goals) {
      for (const m of g.milestones) {
        goalByMilestoneId.set(m.id, { slug: g.slug, title: g.title, mainMergeSha: g.main_merge_sha });
      }
    }
    const out = new Map<string, GoalMembership>();
    for (const r of specRows) {
      if (!r.milestone_id) continue;
      const goal = goalByMilestoneId.get(r.milestone_id);
      if (!goal) continue;
      out.set(r.slug, { goalSlug: goal.slug, goalTitle: goal.title, mainMergeSha: goal.mainMergeSha });
    }
    return out;
  } catch (e) {
    console.warn(
      `[blocker-goal-normalize] buildGoalMembershipMap failed — falling back to empty (spec-slug blockers only): ${e instanceof Error ? e.message : String(e)}`,
    );
    return new Map<string, GoalMembership>();
  }
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

/**
 * derive-rollup-status: a spec's BOARD status is ALWAYS DERIVED, never read from the stored `specs.status`
 * column for the planned/in_progress/shipped axis. There is no DB trigger maintaining `specs.status` from
 * phases — the `spec_phases_rollup` trigger was DROPPED (migration
 * 20260725160000_drop_rollup_triggers_and_milestone_status.sql). The canonical rollup
 * (`rollupPhaseStatus`: ignore rejected; all shipped → shipped; any shipped/in_progress → in_progress; else
 * planned) is computed here at read time, so a stored status can never leak onto the board, and the manual
 * status-reconcile writes that used to fight drift are retired.
 *
 * Terminal / override statuses are NOT rollups and still win where they apply (they live on the row, not
 * the phases):
 *   - `deferred`   — the CEO parked the spec (specs.deferred flag); wins over phase progress.
 *   - `folded`     — archived; callers filter it before this runs (isBoardableStatus), but preserved here.
 *
 * `in_review` is DERIVED, NEVER stored (specs-status-overrides-only migration
 * 20260907130000_specs_status_overrides_only_derive_in_review): a spec reads `in_review` iff NO build has
 * started (the phase rollup is still `planned`) AND Vale has not durably passed it
 * (`vale_review_passed_at IS NULL` — the SAME signal the claim-time build gate reads, so the board and the
 * gate can never disagree). Because it can only appear while the rollup is `planned`, a built spec can
 * NEVER read `in_review` — this kills the old drift bug where a stored `in_review` that was never cleared
 * pinned an all-phases-shipped spec in the In Review column. A send-back ("re-review this") is expressed by
 * NULLing `vale_review_passed_at` (`markSpecCardBackToReview`), so it flows through the same derivation.
 *
 * A spec with ZERO phases (a one-shot spec) has nothing to roll up — derive from MERGE PROVENANCE, not the
 * stored `specs.status` column. The one-shot merge hook (`stampSpecMergeProvenance`) writes `specs.merged_pr`
 * / `specs.last_merge_sha` but NEVER advances `specs.status`, so reading the stored column would leak a stale
 * `planned` for a truly-shipped one-shot spec. Provenance set ⇒ `shipped`; else `planned`.
 */
function deriveSpecCardStatus(row: SpecRow, phases: SpecPhase[]): SpecStatus {
  if (row.deferred) return "deferred";
  if (row.status === "folded") return "shipped"; // boardable callers filter folded; preserved for safety
  // Roll the phases up FIRST — phases are ground truth. A one-shot spec (no phases) derives from merge
  // provenance (merged_pr/last_merge_sha), never the stored status column (a stale leak — the merge hook
  // never advances specs.status).
  const rollup: SpecStatus = phases.length
    ? rollupPhaseStatus(phases.map((p, i) => ({ index: i, title: p.title, status: p.status })))
    : row.merged_pr !== null || row.last_merge_sha !== null
      ? "shipped"
      : "planned";
  // in_review is derived: only while nothing has been built (rollup still `planned`) AND Vale hasn't
  // durably passed the current content. Once any phase ships the rollup wins outright.
  if (rollup === "planned" && row.vale_review_passed_at == null) return "in_review";
  return rollup;
}

/**
 * Per-spec pre-merge testing signals consumed by the in_testing deriver
 * (preview-test-promote-pipeline M3). Pure — the callers batch these per workspace (see
 * `readSpecsFromDb`) so the board and the fold gate read the SAME signals and can never disagree.
 *
 *  - `hasPreview`       — a build agent_job for this spec has a Vercel preview URL set (the work is
 *                         deployed onto a per-build preview). When false, no in_testing override applies.
 *  - `specTestGreen`    — the latest spec_test_run for this spec is a clean machine pass (matches the
 *                         fold gate's spec-test rail: agent_verdict approved/needs_human + auto_pass>=1
 *                         + no unresolved auto-`fail` regressions).
 *  - `securityGreen`    — the latest per-slug security-review rollup is `completedClean` (matches the
 *                         fold gate's security rail).
 *  - `merged`           — the branch promoted to main: the build job is terminal `merged` (per-spec PR
 *                         merge) OR every non-rejected phase carries an M5 `merge_sha` (the atomic
 *                         goal→main promotion of a goal-bound spec, which never takes a per-spec PR).
 *                         Together with both-green this is the only path to a shipped derivation.
 */
export interface InTestingSignals {
  hasPreview: boolean;
  specTestGreen: boolean;
  securityGreen: boolean;
  merged: boolean;
  /** All phases accumulated on the spec branch (every phase build_sha'd or terminal), or a 0/1-phase
   *  one-shot. A spec is NOT in_testing until ALL phases are built — not just because P1 made a preview. */
  accumulationComplete: boolean;
  /** REAL-TIME "in progress": the spec's latest build agent_job is actively working (`building`/`running`)
   *  or paused mid-build (`needs_approval`/`needs_input`). Drives the "in progress" column the INSTANT a
   *  build is claimed — before any `build_sha` is stamped — so the roadmap reflects the live pipeline, not a
   *  stored/stamped status. A merely `queued` build stays "planned" (the short pre-build queue window). */
  hasLiveBuild: boolean;
}

/** Build agent_job statuses that mean "a build is actively underway" → the spec derives "in progress" in
 *  real time. `queued`/`queued_resume` are NOT here: a queued build hasn't started, so it stays "planned"
 *  (the short review-passed-but-not-yet-building window). */
const LIVE_BUILD_STATUSES: ReadonlySet<string> = new Set(["building", "running", "needs_approval", "needs_input"]);

/**
 * Apply the in_testing rule over a base derived status (preview-test-promote-pipeline M3). Pure: signals
 * come from the caller. The override slots between in_progress and shipped:
 *
 *  - The explicit lifecycle overrides (deferred / in_review) WIN — they are first-class lifecycle states
 *    and short-circuit ahead of the in_testing rule. `rejected` (a phase-only state) is also left alone.
 *  - When a card has work on a preview (`hasPreview`) but the pre-merge spec-test green AND security
 *    green signals are not BOTH true, the derived status is `in_testing` (regardless of whether the base
 *    rollup would have read in_progress, planned, or — in the post-merge interim before tests land —
 *    shipped). Only when BOTH are green AND the branch promoted (`merged`) does the deriver fall back
 *    to the base `shipped` rollup.
 *  - When there's no preview and the branch hasn't promoted, the base rollup wins exactly as before
 *    (no regression: a card with no preview + no merge stays in_progress/planned).
 *
 * Idempotent over the explicit overrides: a deferred/in_review base status is returned unchanged.
 */
export function applyInTestingOverlay(base: SpecStatus, signals: InTestingSignals): SpecStatus {
  // Explicit lifecycle overrides + the rejected phase-only state win — never replace them with in_testing.
  if (base === "deferred" || base === "in_review" || base === "rejected") return base;
  // A spec is in_testing only with a preview AND all phases accumulated on the branch — a single built
  // phase (P1) that produced a preview must NOT flip the whole spec to in_testing while P2+ are still
  // planned/building. The spec stays in_progress until accumulation completes.
  if (signals.hasPreview && signals.accumulationComplete) {
    const bothGreen = signals.specTestGreen && signals.securityGreen;
    // Only "both green AND merged" allows the shipped derivation through; otherwise the card is in_testing.
    if (bothGreen && signals.merged) return base;
    return "in_testing";
  }
  // REAL-TIME in_progress: a build job is actively working for this spec (or paused mid-build). Show it
  // building the instant the job is claimed — before any build_sha is stamped — so the roadmap tracks the
  // live pipeline. Never downgrades a `shipped` base; won't fire when in_testing applied above. A base that
  // already derives `in_progress` (a phase carries a build_sha) also falls through to the same result.
  if (base !== "shipped" && (signals.hasLiveBuild || base === "in_progress")) return "in_progress";
  return base;
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
    build_sha: p.build_sha ?? null, // spec-goal-branch-pm-flow M2 — branch-build provenance (built, not shipped)
  }));
  const counts: Record<Phase, number> = { planned: 0, in_progress: 0, shipped: 0, rejected: 0 };
  for (const p of phases) counts[p.status]++;
  return {
    slug: row.slug,
    title: row.title,
    // derive-rollup-status: status is the PHASE ROLLUP (or, for a zero-phase one-shot, the merge-provenance
    // derivation), never the stored `specs.status` read — so a stored status can never leak onto the board.
    // Terminal/override (deferred/in_review/folded) still win.
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
    // spec-review-agent Phase 4 / vale-instant-per-spec-review — In Review lane state, the FULL tri-state:
    // null → undefined (never reviewed), true → passed, FALSE → needs_fix (kept, not collapsed). The old
    // `=== true ? true : undefined` mapping threw `false` away, so a failed review rendered identically to an
    // un-reviewed spec on the board — the bug this fixes. Consumers branch on `=== false` for the needs_fix chip.
    valePass: row.vale_pass == null ? undefined : row.vale_pass,
    // build-gate-durable-review-signal — durable pass signal (survives Ada consuming vale_pass). The gate
    // reads THIS, not valePass. Non-null timestamp → passed review.
    valeReviewPassed: row.vale_review_passed_at ? true : undefined,
    adaDisposition: row.ada_disposition ?? undefined,
    intendedStatus: row.intended_status ?? undefined,
    // spec-goal-branch-pm-flow M6 — surface the goal-branch marker M4 stamps (specs.goal_branch_sha) so the
    // board can render where the spec sits in the branch flow (on its spec branch vs accumulated on the goal
    // branch). Null/false on a spec that hasn't merged to its goal branch yet (or a one-off no-goal spec).
    goalBranchSha: row.goal_branch_sha ?? null,
    onGoalBranch: !!row.goal_branch_sha,
    // pm-structured-intent-and-refs Phase 1 — the plain-language intent columns flow through to the
    // SpecCard so the detail page (and the board hover state) can render intent-first. Null-safe.
    why: row.why ?? null,
    what: row.what ?? null,
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

const SPEC_RANK: Record<SpecStatus, number> = { in_progress: 0, in_testing: 0.5, in_review: 1, planned: 2, shipped: 3, deferred: 4, rejected: 5 };

/** Read every boardable spec from `public.specs` + `public.spec_phases` for a workspace, build SpecCards,
 *  resolve Blocked-by slugs against the live set, and (when card-state rows exist) overlay the transient
 *  short-circuit / one-shot-PR flags. This REPLACES the old `readSpecs()` (parseSpec across the .md files).
 *  Sorted by board column then title — the same order callers used to get from the markdown reader. */
async function readSpecsFromDb(workspaceId: string): Promise<SpecCard[]> {
  const rows = (await listSpecsFromDb(workspaceId)).filter((r) => isBoardableStatus(r.status));
  const cards = rows.map(dbRowToSpecCard);
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  // one-off-spec-depending-on-goal-work-blocks-on-the-goal-not-the-member-spec Phase 1 — the workspace's
  // goal-membership index (spec slug → owning goal + goal.main_merge_sha). Built once per workspace read
  // from the spec rows' `milestone_id` join through `listGoals` (goals + milestones fetched in one pair of
  // queries). Best-effort: a read error yields an empty map, which makes the outside-dependent
  // normalization INERT (blocker resolution falls back to the pre-Phase-1 spec-slug behavior).
  const goalByBlockerSlug = await buildGoalMembershipMap(workspaceId, rows);
  for (const c of cards) c.blockedBy = resolveBlockedBy(c, bySlug, goalByBlockerSlug);
  // Card-state overlay (short_circuit / merged_pr) — best-effort. A missing table / read error leaves cards
  // un-overlaid (the canonical row already carries the truth for everything else).
  try {
    const { getSpecCardStates } = await import("@/lib/spec-card-state");
    const states = await getSpecCardStates(workspaceId);
    for (let i = 0; i < cards.length; i++) cards[i] = overlayCardFlags(cards[i], states[cards[i].slug]);
  } catch {
    /* best-effort overlay — the DB row is authoritative for everything else. */
  }
  // vale-instant-per-spec-review — overlay Vale's needs_fix diagnosis onto the cards she FAILED
  // (valePass === false). One batched read of the latest `spec_review_needs_fix` director_activity row per
  // failed slug, so the board can render WHY a review failed (the chip tooltip), not just THAT it failed.
  // Best-effort: a read error leaves the cards showing the plain "needs fix" chip with no reason.
  try {
    const failed = cards.filter((c) => c.valePass === false).map((c) => c.slug);
    if (failed.length) {
      const reasons = await readNeedsFixReasons(workspaceId, failed);
      for (let i = 0; i < cards.length; i++) {
        const nf = reasons.get(cards[i].slug);
        if (nf) cards[i] = { ...cards[i], needsFixReason: nf.reason, needsFixDefects: nf.defects };
      }
    }
  } catch {
    /* best-effort — the needs_fix chip still renders without the reason. */
  }
  // preview-test-promote-pipeline M3 — apply the in_testing derivation. Pure batched read of the same
  // signals the fold gate uses (getLatestSpecTestRuns + getSecurityStateBySlug) plus the per-build preview
  // signal. The board and the fold gate read the same sources, so they can never disagree. Best-effort: a
  // missing signals reader leaves cards at their base rollup (no in_testing flips). Also writes
  // spec_status_history rows when a card crosses an in_testing boundary (best-effort + idempotent).
  try {
    const signals = await readInTestingSignals(workspaceId, cards);
    for (let i = 0; i < cards.length; i++) {
      const sig = signals.get(cards[i].slug);
      if (!sig) continue;
      const overlaid = applyInTestingOverlay(cards[i].status, sig);
      if (overlaid !== cards[i].status) cards[i] = { ...cards[i], status: overlaid };
    }
    // Best-effort + idempotent: fire-and-forget the audit writer; never block the board on its outcome.
    void recordInTestingTransitions(workspaceId, cards);
  } catch {
    /* best-effort — base rollup stands when the signal readers fail. */
  }
  return cards.sort((a, b) => SPEC_RANK[a.status] - SPEC_RANK[b.status] || a.title.localeCompare(b.title));
}

/**
 * vale-instant-per-spec-review — the latest `spec_review_needs_fix` diagnosis per failed slug. One batched
 * `director_activity` read (newest-first), keeping the FIRST row seen per slug (its most recent verdict).
 * Returns a map keyed by slug; absent = no recorded diagnosis (the chip renders without a reason). Read-only,
 * best-effort — the caller swallows any error.
 */
/**
 * Run an `.in("spec_slug", …)` read in slug-batches so the PostgREST request URL never exceeds the
 * ~16KB HTTP header limit (`UND_ERR_HEADERS_OVERFLOW`). Once the workspace's spec count grew past a few
 * hundred, a single `.in("spec_slug", [all slugs])` produced a ~15.6KB URL that threw on EVERY
 * getSpec/roadmap/claim-gate read — wedging the build claim-gate + spec-review lanes (the failure showed
 * up as a swallowed `[object Object]` job error). Batching keeps each URL small; because a given slug's
 * rows all land in ONE batch, per-slug newest-first ordering (first-seen-per-slug reduces) is preserved.
 */
async function inSpecSlugChunks<T>(
  slugs: string[],
  run: (batch: string[]) => PromiseLike<{ data: T[] | null }>,
  size = 80,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < slugs.length; i += size) {
    const { data } = await run(slugs.slice(i, i + size));
    if (data) out.push(...data);
  }
  return out;
}

async function readNeedsFixReasons(
  workspaceId: string,
  slugs: string[],
): Promise<Map<string, { reason: string; defects: string[] }>> {
  const out = new Map<string, { reason: string; defects: string[] }>();
  if (!slugs.length) return out;
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();
  const data = await inSpecSlugChunks<{ spec_slug: string; reason: string | null; metadata: unknown }>(
    slugs,
    (batch) =>
      admin
        .from("director_activity")
        .select("spec_slug, reason, metadata, created_at")
        .eq("workspace_id", workspaceId)
        .eq("action_kind", "spec_review_needs_fix")
        .in("spec_slug", batch)
        .order("created_at", { ascending: false }),
  );
  for (const row of (data ?? []) as { spec_slug: string; reason: string | null; metadata: unknown }[]) {
    if (out.has(row.spec_slug)) continue; // newest-first → first seen is the latest verdict
    const defectsRaw = (row.metadata as { defects?: unknown } | null)?.defects;
    const defects = Array.isArray(defectsRaw) ? defectsRaw.map((d) => String(d)) : [];
    out.set(row.spec_slug, { reason: (row.reason ?? "").trim(), defects });
  }
  return out;
}

/**
 * Per-build preview signals (preview-test-promote-pipeline M3). One batched read per workspace, mirroring
 * the shape of `getAutoFoldEligibleSlugs` so the board and the fold gate can't disagree. Returns a
 * map keyed by spec slug — absent entries mean "no in_testing override; keep the base rollup."
 *
 * Reads three sources in parallel:
 *   - `agent_jobs` `kind='build'` rows per slug (latest one wins) for the preview presence + merged signal.
 *     Read defensively (`select("*")`) so a deploy that lands before the `preview_url` column migration
 *     applies degrades gracefully (column absent ⇒ undefined ⇒ no preview ⇒ no in_testing override).
 *   - `getLatestSpecTestRuns` for the spec-test green signal — clean MACHINE pass mirror of the fold gate.
 *   - `getSecurityStateBySlug` for the security green signal — same `completedClean` rollup the fold gate
 *     reads.
 */
async function readInTestingSignals(workspaceId: string, cards: SpecCard[]): Promise<Map<string, InTestingSignals>> {
  const out = new Map<string, InTestingSignals>();
  if (!cards.length) return out;
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { getLatestSpecTestRuns, getHumanCheckResolutions, isCleanMachinePassRun } = await import("@/lib/spec-test-runs");
    const { getSecurityStateBySlug } = await import("@/lib/security-agent");
    const admin = createAdminClient();
    const [jobRowsRes, runs, resolutions, securityBySlug] = await Promise.all([
      // list-specs-with-phases-rpc Phase 3 — server-side rollup. `roadmap_latest_build_signals` returns
      // ONE row per spec_slug (the LATEST kind='build' agent_jobs row) via a `distinct on (spec_slug)
      // order by spec_slug, created_at desc` scan of the (workspace_id, spec_slug, created_at desc)
      // index. Replaces the prior slug-batched `.in("spec_slug", [...]) limit(2000)` fan-out that grew
      // with the workspace's spec count and was the cause of the slow roadmap page load. No id/slug
      // array crosses the wire.
      admin.rpc("roadmap_latest_build_signals", { p_workspace_id: workspaceId }),
      getLatestSpecTestRuns(workspaceId),
      getHumanCheckResolutions(workspaceId),
      getSecurityStateBySlug(admin, workspaceId),
    ]);
    if (jobRowsRes.error) throw jobRowsRes.error;
    const latestJobBySlug = new Map<string, { status: string; preview_url: string | null }>();
    for (const row of (jobRowsRes.data ?? []) as { spec_slug: string; status: string | null; preview_url: string | null }[]) {
      if (!row.spec_slug || latestJobBySlug.has(row.spec_slug)) continue;
      latestJobBySlug.set(row.spec_slug, { status: String(row.status ?? ""), preview_url: row.preview_url });
    }
    for (const card of cards) {
      const job = latestJobBySlug.get(card.slug);
      const previewUrl = job ? job.preview_url : undefined;
      const jobStatus = job ? job.status : "";
      const hasPreview = typeof previewUrl === "string" && previewUrl.length > 0;
      // REAL-TIME in_progress signal: the latest build job for this spec is actively working/paused-mid-build
      // (not merely queued, not terminal). The overlay uses it to show "in progress" before any build_sha lands.
      const hasLiveBuild = LIVE_BUILD_STATUSES.has(jobStatus);
      // Per the spec: "Only when both are green AND the branch promoted (merged to main) does it derive
      // shipped." Treat the build job's terminal `merged` status as the promotion signal — the canonical
      // "the PR is now on main" state agent_jobs carries for a PER-SPEC PR merge.
      //
      // post-M5-goal-finalization: a GOAL-BOUND spec NEVER takes a per-spec PR merge — its whole goal branch
      // lands on main in ONE atomic `/merges` call (spec-goal-branch-pm-flow M5), and its build job stays
      // `completed`, never `merged`. So keying solely on the build-job status left every goal-promoted spec
      // stuck `in_testing` forever (never derived-shipped ⇒ never fold-eligible — the exact post-M5 lingering
      // this fixes). The M5 stamp lands on the PHASES: `applyGoalPromotionEffects` flips every phase shipped
      // with the atomic merge_sha. So a card whose every non-rejected phase carries a `merge_sha` IS on main —
      // treat that as the promotion signal too (a phase merge_sha is the actual main commit, a stronger proof
      // than a build-job status flag).
      const phasesOnMain =
        card.phases.length > 0 &&
        card.phases.every((p) => p.status === "rejected" || (p.merge_sha ?? null) !== null);
      const merged = jobStatus === "merged" || phasesOnMain;
      // Spec-test green — the SAME shared predicate `isCleanMachinePassRun` the fold gate
      // (`getAutoFoldEligibleSlugs`) + the pre-merge promote gate (`getSpecTestStateForBranch`) use, so the
      // board's in_testing overlay can never disagree with the gates: approved/needs_human verdict + the
      // run ASSERTED ≥1 check (the total_checks floor that replaced the old auto_pass>=1 floor — a human-only
      // run promotes; human checks advisory) + no unresolved auto-`fail` regression.
      const run = runs[card.slug];
      const specTestGreen = !!run && isCleanMachinePassRun(run, resolutions, card.slug);
      // Security green — same `completedClean` rollup the fold gate reads.
      const securityGreen = !!securityBySlug[card.slug]?.completedClean;
      // spec-goal-branch-pm-flow fix: a spec is in_testing only once ALL phases have accumulated on the
      // branch (every phase build_sha'd or terminal). A single built phase (P1) of a MULTI-phase spec does
      // NOT flip the whole spec to in_testing while P2+ are still planned — it stays in_progress.
      // single-phase-in-testing fix: a 0- or 1-phase spec ships in ONE PR — there's nothing to accumulate,
      // so it's trivially complete (mirrors specs-table `isSpecAccumulationComplete`, which the merge gate
      // uses). Without this the board required a build_sha the single-phase build path can lag on, so a
      // single-phase spec with a live preview never showed "in testing" (research-competitors-table).
      const accumulationComplete =
        card.phases.length <= 1 ||
        card.phases.every((p) => !!p.build_sha || p.status === "shipped" || p.status === "rejected");
      out.set(card.slug, { hasPreview, specTestGreen, securityGreen, merged, accumulationComplete, hasLiveBuild });
    }
  } catch {
    /* best-effort — the deriver short-circuits to base rollup when signals can't be loaded. */
  }
  return out;
}

/**
 * preview-test-promote-pipeline M3 — Phase 3 audit writer. For each card whose derived status crosses
 * an in_testing boundary (→ in_testing, in_testing → shipped, in_testing → in_progress on a re-build),
 * append a `spec_status_history` row recording the transition (supervisable-autonomy: every state
 * change is surfaced, not silent).
 *
 * Idempotency: the writer compares each card's CURRENT derived status to the to_value of the most-recent
 * `field='status'` history row for that slug; only a net change writes a row. So a duplicate getRoadmap
 * call (the hot path on every dashboard render) is a no-op — the latest history row already records the
 * current state. Best-effort + audited via the same `spec_status_history` table the existing writers use:
 * a missing table / read error / insert error never breaks the board read.
 *
 * Schema (probe of `spec_status_history`, see `supabase/migrations/20260624130000_spec_status_history.sql`):
 *   workspace_id, spec_slug, field ∈ ('status','phase','critical','deferred'), phase_index nullable,
 *   from_value text (JSON-stringified prior), to_value text (JSON-stringified next, REQUIRED), actor,
 *   reason, at. The `field` CHECK constraint allows 'status', which is what we write here.
 */
async function recordInTestingTransitions(workspaceId: string, cards: SpecCard[]): Promise<void> {
  if (!cards.length) return;
  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const admin = createAdminClient();
    // list-specs-with-phases-rpc Phase 3 — server-side rollup. `roadmap_latest_status_transitions`
    // returns ONE (spec_slug, to_value) row per spec_slug (the LATEST field='status' row) via a
    // `distinct on (spec_slug) order by spec_slug, at desc` scan of the (workspace_id, spec_slug, at
    // desc) index. Replaces the prior slug-batched `.in("spec_slug", [...]) limit(5000)` fan-out — the
    // idempotency check now runs on a bounded workspace-scoped set instead of the full history table.
    const { data: statusRows, error: statusErr } = await admin.rpc(
      "roadmap_latest_status_transitions",
      { p_workspace_id: workspaceId },
    );
    if (statusErr) throw statusErr;
    const latestBySlug = new Map<string, string>();
    for (const r of (statusRows ?? []) as { spec_slug: string; to_value: string }[]) {
      if (r.spec_slug && !latestBySlug.has(r.spec_slug)) latestBySlug.set(r.spec_slug, r.to_value);
    }
    const rows: {
      workspace_id: string;
      spec_slug: string;
      field: "status";
      phase_index: null;
      from_value: string | null;
      to_value: string;
      actor: string;
      reason: string;
    }[] = [];
    for (const card of cards) {
      const next = JSON.stringify(card.status);
      const priorRaw = latestBySlug.get(card.slug);
      // No prior row → only emit a row when entering / exiting in_testing (boundary transitions). A
      // brand-new spec at planned/in_progress/shipped shouldn't get an audit row from the deriver — that's
      // the existing writers' job. We only care about in_testing edges here.
      if (!priorRaw) {
        if (card.status !== "in_testing") continue;
        rows.push({
          workspace_id: workspaceId,
          spec_slug: card.slug,
          field: "status",
          phase_index: null,
          from_value: null,
          to_value: next,
          actor: "deriver:in_testing",
          reason: "entered in_testing (preview up, tests pending)",
        });
        continue;
      }
      if (priorRaw === next) continue; // idempotent — already recorded
      // We only emit on in_testing BOUNDARIES (→ in_testing, in_testing → x). Other transitions are
      // recorded by the existing writers (merge:<sha>, owner:<id>, drift:reconciler, etc.).
      let prior: string | null = null;
      try { prior = JSON.parse(priorRaw) as string; } catch { prior = null; }
      const wasInTesting = prior === "in_testing";
      const isInTesting = card.status === "in_testing";
      if (!wasInTesting && !isInTesting) continue;
      const reason = isInTesting
        ? "entered in_testing (preview up, tests pending)"
        : card.status === "shipped"
          ? "exited in_testing → shipped (both green + merged)"
          : card.status === "in_progress"
            ? "exited in_testing → in_progress (re-build started)"
            : `exited in_testing → ${card.status}`;
      rows.push({
        workspace_id: workspaceId,
        spec_slug: card.slug,
        field: "status",
        phase_index: null,
        from_value: priorRaw,
        to_value: next,
        actor: "deriver:in_testing",
        reason,
      });
    }
    if (rows.length) {
      await admin.from("spec_status_history").insert(rows).then(undefined, () => {});
    }
  } catch {
    /* best-effort — the board read never fails because the audit writer hiccuped. */
  }
}

/** Serialize a DB SpecRow back to a markdown blob with the same shape parseSpec/extractSpecSection/
 *  parseRepairSpecMeta/parseGoalSpecBlockers/buildSpecModal expect — preserves the H1, the
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
  // `## Phase N — {title}` heading and the body verbatim. The serializer OWNS the `Phase N — ` prefix, so a
  // stored title that ALREADY carries a leading `Phase N —/-/:` (parseSpec keeps the whole `Phase 1 — close
  // it` as the title; repair/box authors sometimes store it too) is normalized off here — otherwise it
  // double-prefixes ("## Phase 1 — Phase 1 — close it"). Anchored to the line start, case-insensitive.
  const phases = row.phases.slice().sort((a, b) => a.position - b.position);
  for (const p of phases) {
    const bareTitle = String(p.title || "").replace(/^\s*phase\s*\d+\s*[—\-:]\s*/i, "").trim();
    out.push(`## Phase ${p.position} — ${bareTitle}`);
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
      const counts: Record<SpecStatus, number> = { planned: 0, in_progress: 0, in_testing: 0, in_review: 0, shipped: 0, deferred: 0, rejected: 0 };
      for (const s of list) counts[s.status]++;
      const pmap = new Map<string, SpecCard[]>();
      for (const s of list) {
        const key = s.parent || "(unparented)";
        const arr = pmap.get(key) || [];
        arr.push(s);
        pmap.set(key, arr);
      }
      const rank: Record<SpecStatus, number> = { in_progress: 0, in_testing: 0.5, in_review: 1, planned: 2, shipped: 3, deferred: 4, rejected: 5 };
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
 * Derive a spec's overall status from a REWRITTEN parent spec's in-memory markdown (no disk read) —
 * the ONLY residual read-side markdown consumer, guarded to `platform-director.validateGroomSplit`'s
 * would-this-fold check on a groom split verdict (never a stored body; the DB is the spec).
 * pm-structured-intent-and-refs Phase 4 renamed this from `deriveSpecStatus` to make the transport
 * role explicit.
 */
export function deriveSpecStatusFromMarkdown(raw: string): SpecStatus {
  return parseAuthoredSpecMarkdown("_", raw).status;
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
  // cleared/uncleared state as the board (spec-blockers). one-off-spec-depending-on-goal-work-blocks-
  // on-the-goal-not-the-member-spec Phase 1 — the workspace goal-membership index (loaded once from
  // the SAME listSpecs rows readSpecsFromDb consumes) so the outside-dependent normalization runs on
  // the single-slug getSpec path (BuildButton) with the exact same predicate as the board.
  const allRows = (await listSpecsFromDb(wsId)).filter((r) => isBoardableStatus(r.status));
  const specs = allRows.map(dbRowToSpecCard);
  const goalByBlockerSlug = await buildGoalMembershipMap(wsId, allRows);
  card.blockedBy = resolveBlockedBy(card, new Map(specs.map((c) => [c.slug, c])), goalByBlockerSlug);
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
  /** spec-goal-branch-pm-flow M6 — the goal's goal-branch accumulation state (the board's "N of M specs on
   *  the goal branch" + "ready to promote" surface). Computed from the linked specs' `goal_branch_sha`
   *  markers (M4) + the parent-goal exemption (M5). Always present (a zero-spec goal reads 0-of-0). */
  accumulation: GoalBranchAccumulation;
  /** goal-promotion-fold-collision-and-held-surfacing Phase 2 — TRUE iff the M5 atomic goal→main promotion
   *  either 409'd (stored `goals.promotion_held_reason`) OR the goal is derived-complete but has no atomic
   *  merge SHA on record (silent-stall backstop; the 2026-07-06 incident shape). When true, the roadmap
   *  goal list + detail render a "HELD — needs owner" badge with `promotionHeldReason`, and `status` is
   *  forced OFF `complete` so the goal never leaks as fully shipped. See [[deriveGoalPromotionSurface]]. */
  promotionHeld: boolean;
  /** Human-readable HELD reason to render on the badge. Empty string when `promotionHeld` is false. */
  promotionHeldReason: string;
  /** The M5 atomic goal→main merge SHA, or null while the goal branch has not landed on main. Surfaced so
   *  the detail page can link to the merge commit and any downstream verifier can prove "code is on main". */
  mainMergeSha: string | null;
}

/**
 * spec-goal-branch-pm-flow M6 — the goal-branch accumulation a goal card surfaces. The branch-flow model
 * (M4/M5): each finished spec's branch merges onto `goal/{slug}` (stamping `specs.goal_branch_sha`); when
 * EVERY member spec is on the goal branch (and green), the whole goal atomic-promotes to main in ONE merge.
 * This is the READ surface of that accumulation — purely derived from the linked SpecCards' `onGoalBranch`
 * flags + the parent-goal exemption, no extra DB I/O on the hot board path.
 */
export interface GoalBranchAccumulation {
  /** Member specs whose branch has merged onto the goal branch (`goal_branch_sha` set). */
  onGoalBranch: number;
  /** Total member specs (the denominator) — the "M" in "N of M on the goal branch". */
  totalSpecs: number;
  /** true iff there is ≥1 member spec AND every one is on the goal branch — the goal is fully accumulated
   *  and (when its goal-branch preview is green) about to atomic-promote to main. The board's "ready to
   *  promote" indicator. A zero-spec / partially-accumulated goal is false. */
  allOnGoalBranch: boolean;
  /** true when this goal is EXEMPT from the atomic goal→main promotion (a PARENT goal — `is_parent`, or it
   *  has child goals, or it has no buildable member specs). Its sub-goals promote INDEPENDENTLY; the board
   *  shows the sub-goals accumulating, not a whole-goal promote (mirrors `isGoalParentExempt`'s rule). */
  exempt: boolean;
  /** Short human reason for the exemption (surfaced as the chip tooltip); empty when not exempt. */
  exemptReason: string;
}

/** spec-goal-branch-pm-flow M6 — derive a goal's branch accumulation from its already-resolved member
 *  SpecCards (deduped by slug across milestones) + the exemption signal. Pure: the caller passes the specs
 *  and the exemption (computed once from the loaded GoalRow set so the hot board path makes no extra reads). */
export function deriveGoalAccumulation(
  memberSpecs: SpecCard[],
  exempt: { exempt: boolean; reason: string },
): GoalBranchAccumulation {
  const onGoalBranch = memberSpecs.filter((s) => s.onGoalBranch).length;
  const totalSpecs = memberSpecs.length;
  return {
    onGoalBranch,
    totalSpecs,
    allOnGoalBranch: totalSpecs > 0 && onGoalBranch === totalSpecs,
    exempt: exempt.exempt,
    exemptReason: exempt.exempt ? exempt.reason : "",
  };
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
 * same shape the old reader produced): the mean of each linked spec's `specCompletion`. With NO linked
 * specs a milestone is `planned` with completion `0` — there is nothing to roll up (milestone status is
 * purely DERIVED from children now that `goal_milestones.status` is dropped). `status` is DERIVED from
 * that same completion: all linked specs done ⇒ shipped, any progress ⇒ in_progress, else planned.
 */
function milestoneRowToCard(m: GoalMilestoneRow, linked: SpecCard[]): Milestone {
  const completion = linked.length
    ? linked.reduce((a, s) => a + specCompletion(s), 0) / linked.length
    : 0;
  const status: Phase = completion >= 1 ? "shipped" : completion > 0 ? "in_progress" : "planned";
  // Milestone title carries the human label (and any `M1 — ` prefix) — surface it as the card name. Its
  // body may contain a `**Metric:**` line + spec wikilinks (used by getRoadmapFilters membership).
  //
  // specSlugs is the RELATIONAL linkage (`specs.milestone_id` → the `linked` SpecCards), UNIONed with any
  // legacy body wikilinks. The relational join is the canonical PM-flow source now (Pia's decomposition +
  // the structured author bind `milestone_id`; milestone bodies are prose like "Holds spec X." with NO
  // wikilink). Reading only wikilinks left `specSlugs` empty for every relationally-linked goal — so the
  // escort's `goalSpecs` (and the dashboard's per-milestone spec list) saw NO specs, and a greenlit goal's
  // decomposed specs never built. Union so both old wikilink goals and new relational goals resolve.
  const specSlugs = [...new Set([...linked.map((s) => s.slug), ...specWikilinks(`${m.title}\n${m.body ?? ""}`)])];
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
function goalRowToCard(
  row: GoalRow,
  specsByMilestone: Map<string, SpecCard[]>,
  // spec-goal-branch-pm-flow M6 — the loaded goal set, used to derive THIS goal's parent-goal exemption (the
  // has-sub-goals check) with no extra DB reads. Defaults to `[row]` for callers that don't supply it
  // (folded-goal archive reads): a goal can't be its own child, so the exemption falls back to is_parent /
  // no-buildable-specs only.
  allRows: GoalRow[] = [row],
): GoalCard {
  let linkedSpecCount = 0;
  // spec-goal-branch-pm-flow M6 — dedupe THIS goal's member specs by slug across ITS milestones (a spec can
  // be linked through more than one milestone). Collect them here, keyed off `row.milestones`, so the count
  // is scoped to this goal. (Iterating `specsByMilestone.values()` instead would leak EVERY goal's specs on
  // the list path, where the map covers all active goals' milestones — the "N of 47" board bug.)
  const memberBySlug = new Map<string, SpecCard>();
  const milestones = row.milestones.map((m) => {
    const linked = specsByMilestone.get(m.id) ?? [];
    linkedSpecCount += linked.length;
    for (const s of linked) memberBySlug.set(s.slug, s);
    return milestoneRowToCard(m, linked);
  });
  const pct = milestones.length
    ? Math.round((milestones.reduce((a, m) => a + m.completion, 0) / milestones.length) * 100)
    : 0;
  // DERIVED status: a goal whose milestones ALL roll up complete (completion ≥ 1, inferred from children)
  // IS complete; otherwise the stored row status (proposed | greenlit). Completion comes from the linked
  // specs — never invent `complete` for a goal with zero milestones or a milestone with no linked specs.
  const allComplete = milestones.length > 0 && milestones.every((m) => m.completion >= 1);
  // spec-goal-branch-pm-flow M6 — the goal-branch accumulation, derived from THIS goal's deduped member
  // specs (collected above from `row.milestones`) so the "N of M on the goal branch" count matches
  // `goalBranchState`'s unique-spec set + the `linkedSpecCount`/detail-page scoping.
  const members = [...memberBySlug.values()];
  const exempt = deriveGoalExemption(row, allRows, members.length);
  const accumulation = deriveGoalAccumulation(members, exempt);
  // goal-promotion-fold-collision-and-held-surfacing Phase 2 — resolve the HELD surface via the pure
  // predicate. Overrides the naive `status = allComplete ? complete : storedStatus` derivation so a goal
  // whose atomic promotion has NOT landed (409'd, or silent-stall shape) never leaks as `complete`. See
  // [[deriveGoalPromotionSurface]] for the four rules.
  const promotion = deriveGoalPromotionSurface({
    storedStatus: row.status,
    derivedComplete: allComplete,
    exempt: exempt.exempt,
    mainMergeSha: row.main_merge_sha,
    promotionHeldReason: row.promotion_held_reason,
  });
  const status: GoalStatus = promotion.cardStatus;
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
    accumulation,
    promotionHeld: promotion.promotionHeld,
    promotionHeldReason: promotion.promotionHeldReason,
    mainMergeSha: row.main_merge_sha,
  };
}

/**
 * spec-goal-branch-pm-flow M6 — the parent-goal exemption for a goal, computed from already-loaded data (no
 * extra DB reads). Mirrors `goals-table.isGoalParentExempt`'s rule so the board's "ready to promote" UI and
 * the M5 promoter agree: EXEMPT iff (a) `is_parent`, OR (b) it has child goals (any loaded row points its
 * `parent_goal_id` here), OR (c) it has zero buildable member specs. `allRows` is the loaded goal set (for
 * the child-goal check); `linkedSpecCount` is this goal's resolvable member-spec count.
 */
function deriveGoalExemption(row: GoalRow, allRows: GoalRow[], linkedSpecCount: number): { exempt: boolean; reason: string } {
  if (row.is_parent) return { exempt: true, reason: "parent goal (is_parent)" };
  if (allRows.some((g) => g.parent_goal_id === row.id)) return { exempt: true, reason: "has sub-goals (structural parent)" };
  if (linkedSpecCount === 0) return { exempt: true, reason: "no buildable member specs" };
  return { exempt: false, reason: "" };
}

/** Resolve each milestone of a goal to its linked SpecCards, keyed by milestone id. Reads child specs via
 *  the specs-table SDK (`specsForMilestone`) and maps them to SpecCards from the already-loaded board set
 *  (so completion mirrors the board exactly), falling back to a fresh DB read for any not on the board.
 *
 *  goal-completion-counts-folded-specs: FOLDED specs are INCLUDED in this set — folded is the terminal done
 *  state (shipped → archived into the brain), strictly *more* complete than shipped, so it must count TOWARD
 *  goal/milestone completion, never against it. The old `.filter(isBoardableStatus)` dropped folded here
 *  (folded leaves the board), so once a goal's specs folded they vanished from the completion count and a
 *  fully-folded goal derived `0 of 0 → 0%` — the more done it got, the lower its % dropped. A folded row is
 *  off the board (`board` excludes it), so it always takes the `dbRowToSpecCard(r)` fallback, which maps
 *  `status='folded'` → a `shipped` card (deriveSpecCardStatus) — and `specCompletion` returns 1 for shipped.
 *  Net: a folded spec counts as COMPLETE. Boardable (non-folded) specs still prefer their resolved board card. */
async function specsByMilestoneForGoals(workspaceId: string, goals: GoalRow[], board: SpecCard[]): Promise<Map<string, SpecCard[]>> {
  const bySlug = new Map(board.map((c) => [c.slug, c]));
  const out = new Map<string, SpecCard[]>();
  const milestoneIds = goals.flatMap((g) => g.milestones.map((m) => m.id));
  await Promise.all(
    milestoneIds.map(async (mid) => {
      const rows = await specsForMilestone(workspaceId, mid);
      // Prefer the board's already-resolved SpecCard (carries blocker resolution + card-state overlay); fall
      // back to a fresh map of the raw row for any spec not on the board — a folded spec is off the board, so
      // it takes this fallback, where dbRowToSpecCard maps folded → a shipped card (counts as complete).
      const cards = rows.map((r) => bySlug.get(r.slug) ?? dbRowToSpecCard(r));
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
  // Pass the loaded `active` set so each card derives its parent-goal exemption (the has-sub-goals check)
  // with no extra reads (spec-goal-branch-pm-flow M6).
  return active
    .map((row) => goalRowToCard(row, specsByMilestone, active))
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
  // Load the full goal set so the card's parent-goal exemption can run the has-sub-goals check (M6). The
  // detail page isn't the hot board path, so the extra list read is fine; failure falls back to [row].
  const [{ specs }, allRows] = await Promise.all([
    getRoadmap(wsId),
    listGoalsFromDb(wsId).catch(() => [row]),
  ]);
  const specsByMilestone = await specsByMilestoneForGoals(wsId, [row], specs);
  const card = goalRowToCard(row, specsByMilestone, allRows);
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
