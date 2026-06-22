/**
 * Brain roadmap parser — reads docs/brain/specs/*.md + specs/README.md and turns
 * the ⏳ / 🚧 / ✅ phase emojis into structured data for the /dashboard/roadmap board.
 *
 * The markdown IS the source of truth (per docs/brain/project-management.md), so this
 * never drifts: editing a spec updates the board, and a build flipping a phase emoji
 * shows up here. No DB. Read-only at request time.
 *
 * Vercel: docs/brain/** is traced into the function bundle via outputFileTracingIncludes
 * in next.config.ts (the "/dashboard/roadmap" entry).
 */
import { promises as fs } from "fs";
import path from "path";

export type Phase = "planned" | "in_progress" | "shipped" | "rejected";

export interface SpecPhase {
  title: string;
  status: Phase;
}

export interface SpecCard {
  slug: string;
  title: string;
  status: Phase;
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

function deriveStatus(counts: Record<Phase, number>, titleStatus: Phase | null): Phase {
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

function parseSpec(slug: string, raw: string): SpecCard {
  const lines = raw.split("\n");

  let title = slug;
  let titleStatus: Phase | null = null;
  const titleLine = lines.find((l) => l.startsWith("# "));
  if (titleLine) {
    title = cleanInline(titleLine.slice(2));
    titleStatus = statusFromText(titleLine);
  }

  const phases: SpecPhase[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(Phase\b.*)/);
    if (!m) continue;
    let st = statusFromText(lines[i]);
    if (!st) {
      // emoji may live on the first bullet under the heading
      for (let j = i + 1; j < lines.length && !lines[j].startsWith("## "); j++) {
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
      const st = statusFromText(lines[i]);
      if (!st) continue; // a phase bullet must carry ⏳/🚧/✅/❌
      phases.push({ title: cleanInline(bm[1]), status: st });
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

  return {
    slug,
    title,
    status: deriveStatus(counts, titleStatus),
    summary: firstParagraph(lines),
    phases,
    counts,
    owner,
    parent,
    blockedBy: [...new Set(blockerSlugs)].map((s) => ({ slug: s, title: s, status: "planned" as Phase, cleared: false })),
    autoBuild,
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
      return { slug: b.slug, title: target.title, status: target.status, cleared: target.status === "shipped" };
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

async function readSpecs(): Promise<SpecCard[]> {
  let files: string[];
  try {
    files = await fs.readdir(SPECS_DIR);
  } catch {
    return [];
  }
  const cards = await Promise.all(
    files
      .filter((f) => f.endsWith(".md") && f !== "README.md")
      .map(async (f) => parseSpec(f.replace(/\.md$/, ""), await fs.readFile(path.join(SPECS_DIR, f), "utf8"))),
  );
  // Resolve every spec's Blocked-by slugs against the live set, so the board + the enqueue gate share one
  // source of truth for cleared/uncleared (spec-blockers). A blocker not in this map = archived/folded ⇒ cleared.
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  for (const c of cards) c.blockedBy = resolveBlockedBy(c, bySlug);
  // newest-feeling first: in-progress, then planned, then shipped; stable by title
  const rank: Record<Phase, number> = { in_progress: 0, planned: 1, shipped: 2, rejected: 4 };
  return cards.sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title));
}

async function readTracks(): Promise<ProjectTrack[]> {
  try {
    return parseTracks(await fs.readFile(path.join(SPECS_DIR, "README.md"), "utf8"));
  } catch {
    return [];
  }
}

export async function getRoadmap(): Promise<RoadmapData> {
  const [specs, tracks] = await Promise.all([readSpecs(), readTracks()]);
  return { specs, tracks };
}

/** Slugs of every spec file (no README). Used to resolve [[wikilinks]] to detail pages. */
export async function listSpecSlugs(): Promise<string[]> {
  try {
    const files = await fs.readdir(SPECS_DIR);
    return files.filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
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
  counts: Record<Phase, number>;
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
export async function getFunctionMap(): Promise<FunctionMap> {
  const { specs } = await getRoadmap();
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
      const counts: Record<Phase, number> = { planned: 0, in_progress: 0, shipped: 0, rejected: 0 };
      for (const s of list) counts[s.status]++;
      const pmap = new Map<string, SpecCard[]>();
      for (const s of list) {
        const key = s.parent || "(unparented)";
        const arr = pmap.get(key) || [];
        arr.push(s);
        pmap.set(key, arr);
      }
      const rank: Record<Phase, number> = { in_progress: 0, planned: 1, shipped: 2, rejected: 3 };
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
 * Source of truth is docs/brain/archive.d/{slug}.md (one file per spec, fold-build-batching Phase 3):
 * read those directly so two parallel folds never collide on a shared file. Falls back to the
 * generated docs/brain/archive.md (e.g. if archive.d/ isn't bundled). Newest first, tie-broken by slug.
 */
export async function getArchive(): Promise<ArchiveEntry[]> {
  try {
    const files = (await fs.readdir(ARCHIVE_DIR)).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
    if (files.length) {
      const parsed = await Promise.all(
        files.map(async (f) => {
          const raw = await fs.readFile(path.join(ARCHIVE_DIR, f), "utf8");
          const line = raw.split("\n").find((l) => l.trim().startsWith("- "));
          const entry = line ? parseArchiveLine(line) : null;
          return entry ? { slug: f.replace(/\.md$/, ""), entry } : null;
        }),
      );
      const entries = parsed.filter((x): x is { slug: string; entry: ArchiveEntry } => x !== null);
      if (entries.length) {
        entries.sort((a, b) => b.entry.date.localeCompare(a.entry.date) || a.slug.localeCompare(b.slug));
        return entries.map((e) => e.entry);
      }
    }
  } catch {
    /* no archive.d/ (or unreadable) — fall back to the generated archive.md */
  }
  let raw: string;
  try {
    raw = await fs.readFile(ARCHIVE_FILE, "utf8");
  } catch {
    return [];
  }
  const entries: ArchiveEntry[] = [];
  for (const line of raw.split("\n")) {
    const entry = parseArchiveLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
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
export function deriveSpecStatus(raw: string): Phase {
  return parseSpec("_", raw).status;
}

export async function getSpec(slug: string): Promise<{ raw: string; card: SpecCard } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(SPECS_DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
  const card = parseSpec(slug, raw);
  // Resolve Blocked-by against the live spec set so the detail page's BuildButton sees the same
  // cleared/uncleared state as the board (spec-blockers).
  const specs = await readSpecs();
  card.blockedBy = resolveBlockedBy(card, new Map(specs.map((c) => [c.slug, c])));
  return { raw, card };
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

export interface GoalCard {
  slug: string;
  title: string;
  outcome: string; // **Outcome:** …
  successMetric: string; // **Success metric:** …
  target: string; // **Target:** …
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
export async function getFunction(slug: string): Promise<{ raw: string; card: FunctionCard; group: FunctionGroup | null } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(FUNCTIONS_DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
  const card = parseFunction(slug, raw);
  const { functions } = await getFunctionMap();
  return { raw, card, group: functions.find((f) => f.fn === slug) ?? null };
}

export async function getGoals(): Promise<GoalCard[]> {
  const [{ specs }, slugs] = await Promise.all([getRoadmap(), listGoalSlugs()]);
  const cards = await Promise.all(
    slugs.map(async (s) => parseGoal(s, await fs.readFile(path.join(GOALS_DIR, `${s}.md`), "utf8"), specs)),
  );
  return cards.sort((a, b) => a.title.localeCompare(b.title));
}

/** One goal: card (with rollup), raw markdown, and the resolved SpecCard for each linked milestone spec. */
export async function getGoal(slug: string): Promise<{ raw: string; card: GoalCard; specs: Record<string, SpecCard> } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(GOALS_DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
  const { specs } = await getRoadmap();
  const card = parseGoal(slug, raw, specs);
  const bySlug: Record<string, SpecCard> = {};
  for (const s of specs) bySlug[s.slug] = s;
  return { raw, card, specs: bySlug };
}
