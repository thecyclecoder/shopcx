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

/** Strip bold markers + collapse [[wikilink|alias]] / [[wikilink]] to plain text for display. */
function cleanInline(s: string): string {
  return stripEmoji(s)
    .replace(/\*\*/g, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, link, alias) => alias || link)
    .trim();
}

function deriveStatus(counts: Record<Phase, number>, titleStatus: Phase | null): Phase {
  // A whole spec is never "rejected"; rejection is a phase-level state. Cut phases don't block shipped.
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

  return {
    slug,
    title,
    status: deriveStatus(counts, titleStatus),
    summary: firstParagraph(lines),
    phases,
    counts,
    owner,
    parent,
  };
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

/**
 * Parse archive.md's index list. Each verified feature is one list item shaped
 *   - **Title** · verified YYYY-MM-DD · → [[lifecycles/{slug}]]
 * The fold-build appends these on verify (see docs/brain/project-management.md). Newest first
 * (file order is authored newest-first). Tolerant: skips the "No features archived yet." placeholder.
 */
export async function getArchive(): Promise<ArchiveEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(ARCHIVE_FILE, "utf8");
  } catch {
    return [];
  }
  const entries: ArchiveEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("- ")) continue;
    const link = t.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/);
    if (!link) continue; // index rows always carry a wikilink; prose/placeholder don't
    const target = link[1].trim().replace(/^\.\.\//, "").replace(/\.md$/, "");
    const date = (t.match(/verified\s+(\d{4}-\d{2}-\d{2})/i) || [])[1] || "";
    const titleM = t.match(/\*\*(.+?)\*\*/);
    const title = titleM ? cleanInline(titleM[1]) : cleanInline(t.slice(2).split("·")[0]);
    const label = functionLabel(target.replace(/^.*\//, "")); // humanize last segment
    entries.push({ title, date, link: target, label });
  }
  return entries;
}

/** Raw markdown + parsed card for one spec, or null if it doesn't exist. Slug is path-guarded. */
export async function getSpec(slug: string): Promise<{ raw: string; card: SpecCard } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  try {
    const raw = await fs.readFile(path.join(SPECS_DIR, `${slug}.md`), "utf8");
    return { raw, card: parseSpec(slug, raw) };
  } catch {
    return null;
  }
}

// ── Functions + Goals + Mandates layer (the altitude above specs) ──
// Markdown-first: docs/brain/functions/{slug}.md (the permanent org skeleton) and
// docs/brain/goals/{slug}.md (finite initiatives). Specs declare an owner (a function,
// the DRI) + a parent (a function mandate or a goal milestone) — the no-orphan rule.
// See docs/brain/specs/goal-decomposition-engine.md.

const FUNCTIONS_DIR = path.join(process.cwd(), "docs", "brain", "functions");
const GOALS_DIR = path.join(process.cwd(), "docs", "brain", "goals");

/** Pull every [[wikilink]] target on a line, collapse to the last path segment, drop .md. */
function wikilinkSlugs(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    out.push(m[1].trim().replace(/^.*\//, "").replace(/\.md$/, ""));
  }
  return out;
}

/** A perpetual charter a function owns forever — metric-tracked, never "done" (no %). */
export interface Mandate {
  name: string;
  metric?: string;
  specSlugs: string[];
}
export interface FunctionCard {
  slug: string;
  title: string;
  summary: string; // first paragraph (the charter one-liner)
  mandates: Mandate[];
  goalSlugs: string[]; // owned / contributed goals
  specSlugs: string[]; // every spec wikilinked anywhere in the doc (deduped)
}

/** A finite initiative's sub-goal — rolls up to 100% then closes. */
export interface GoalMilestone {
  id: string; // "M0", "M1"… if labelled, else ""
  title: string;
  status: Phase;
  specSlugs: string[];
}
export interface GoalCard {
  slug: string;
  title: string;
  summary: string; // the outcome line / first paragraph
  successMetric?: string;
  target?: string;
  milestones: GoalMilestone[];
  specSlugs: string[]; // every spec wikilinked under a milestone (deduped)
}

function parseFunction(slug: string, raw: string): FunctionCard {
  const lines = raw.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? cleanInline(titleLine.slice(2)).replace(/\s*\(function\)\s*$/i, "") : functionLabel(slug);

  const mandates: Mandate[] = [];
  const goalSlugs = new Set<string>();
  const allSpecs = new Set<string>();

  // Sections: walk H2s. `## Mandates` holds `### {name}` mandates; `## Owned / contributed goals` holds goal links.
  let section: "" | "mandates" | "goals" = "";
  let cur: Mandate | null = null;
  for (const l of lines) {
    for (const s of wikilinkSlugs(l)) allSpecs.add(s); // collected then filtered to real specs by the caller
    const h2 = l.match(/^##\s+(.*)/);
    if (h2) {
      cur = null;
      const h = h2[1].toLowerCase();
      section = h.startsWith("mandate") ? "mandates" : /owned|contributed|goal/.test(h) ? "goals" : "";
      continue;
    }
    if (section === "mandates") {
      const h3 = l.match(/^###\s+(.*)/);
      if (h3) {
        cur = { name: cleanInline(h3[1]), metric: undefined, specSlugs: [] };
        mandates.push(cur);
        continue;
      }
      if (cur) {
        const met = l.match(/\*\*Metric:\*\*\s*(.+?)\s*$/);
        if (met && !cur.metric) cur.metric = cleanInline(met[1]);
        for (const sp of wikilinkSlugs(l)) cur.specSlugs.push(sp);
      }
    } else if (section === "goals") {
      for (const g of wikilinkSlugs(l)) goalSlugs.add(g);
    }
  }
  return {
    slug,
    title,
    summary: firstParagraph(lines),
    mandates,
    goalSlugs: [...goalSlugs],
    specSlugs: [...allSpecs],
  };
}

function parseGoal(slug: string, raw: string): GoalCard {
  const lines = raw.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? cleanInline(titleLine.slice(2)) : slug;

  let successMetric: string | undefined;
  let target: string | undefined;
  const milestones: GoalMilestone[] = [];
  const allSpecs = new Set<string>();

  let inDecomp = false;
  for (const l of lines) {
    if (!successMetric) {
      const m = l.match(/\*\*Success metric:\*\*\s*(.+?)\s*$/);
      if (m) successMetric = cleanInline(m[1]);
    }
    if (!target) {
      const m = l.match(/\*\*Target:\*\*\s*(.+?)\s*$/);
      if (m) target = cleanInline(m[1]);
    }
    const h2 = l.match(/^##\s+(.*)/);
    if (h2) {
      inDecomp = /decomposition/i.test(h2[1]);
      continue;
    }
    if (inDecomp) {
      // Top-level milestone bullets: `- **M0 — title.** desc … ⏳` (the `[[spec]]` wikilinks may
      // be inline here once approved, or appear on nested lines until the planner wires them).
      const b = l.match(/^[-*]\s+(.*)/);
      if (b) {
        const idm = b[1].match(/\*\*(M\d+)\b[\s—–:-]*([^*]*)\*\*/);
        const id = idm ? idm[1] : "";
        const mtitle = cleanInline(idm ? idm[2] || b[1] : b[1]).replace(/\.$/, "");
        milestones.push({ id, title: mtitle, status: statusFromText(l) ?? "planned", specSlugs: wikilinkSlugs(l) });
      } else if (milestones.length) {
        // continuation / nested line under the last milestone → its spec links
        const last = milestones[milestones.length - 1];
        for (const sp of wikilinkSlugs(l)) last.specSlugs.push(sp);
      }
    }
  }
  for (const ms of milestones) for (const s of ms.specSlugs) allSpecs.add(s);
  return { slug, title, summary: firstParagraph(lines), successMetric, target, milestones, specSlugs: [...allSpecs] };
}

/**
 * Per-spec completion fraction (0..1) for goal rollup. Shipped = 1; otherwise weight
 * in-progress phases as half-done. A linked spec we can't resolve is treated as shipped
 * (1.0): the only way a wikilinked spec leaves docs/brain/specs/ is verify→fold→archive,
 * i.e. it's fully done — so rollup advances (never regresses) as leaves ship + archive.
 */
function specCompletion(card: SpecCard | undefined): number {
  if (!card) return 1;
  if (card.status === "shipped") return 1;
  const total = card.counts.planned + card.counts.in_progress + card.counts.shipped;
  if (total === 0) return 0;
  return (card.counts.shipped + card.counts.in_progress * 0.5) / total;
}

export interface MilestoneView {
  milestone: GoalMilestone;
  specs: SpecCard[];
  rollup: number; // 0..1 over this milestone's linked specs
}
export interface ResolvedGoal {
  goal: GoalCard;
  rollup: number; // 0..1 weighted (equal-weight) avg over all linked specs
  milestoneViews: MilestoneView[];
  specs: SpecCard[]; // resolved linked specs (those still in specs/)
}

/** Join a goal's linked spec slugs to live SpecCards and compute the rollup %. */
function resolveGoal(goal: GoalCard, specsBySlug: Map<string, SpecCard>): ResolvedGoal {
  const rollupOf = (slugs: string[]): number => {
    if (!slugs.length) return 0;
    const sum = slugs.reduce((acc, s) => acc + specCompletion(specsBySlug.get(s)), 0);
    return sum / slugs.length;
  };
  const milestoneViews: MilestoneView[] = goal.milestones.map((m) => ({
    milestone: m,
    specs: m.specSlugs.map((s) => specsBySlug.get(s)).filter((x): x is SpecCard => !!x),
    rollup: rollupOf(m.specSlugs),
  }));
  return {
    goal,
    rollup: rollupOf(goal.specSlugs),
    milestoneViews,
    specs: goal.specSlugs.map((s) => specsBySlug.get(s)).filter((x): x is SpecCard => !!x),
  };
}

async function readDir(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((f) => f.endsWith(".md") && f !== "README.md");
  } catch {
    return [];
  }
}

/** Slugs of every functions/ doc — for wikilink resolution ([[function-slug]] → /functions/{slug}). */
export async function listFunctionSlugs(): Promise<string[]> {
  return (await readDir(FUNCTIONS_DIR)).map((f) => f.replace(/\.md$/, ""));
}
/** Slugs of every goals/ doc — for wikilink resolution ([[goal-slug]] → /goals/{slug}). */
export async function listGoalSlugs(): Promise<string[]> {
  return (await readDir(GOALS_DIR)).map((f) => f.replace(/\.md$/, ""));
}

/** All function cards + their owned-spec breakdown (live status from the specs themselves). */
export async function getFunctions(): Promise<Array<FunctionCard & { active: number; counts: Record<Phase, number> }>> {
  const files = await readDir(FUNCTIONS_DIR);
  const { specs } = await getRoadmap();
  const bySlug = new Map(specs.map((s) => [s.slug, s] as const));
  const cards = await Promise.all(
    files.map(async (f) => parseFunction(f.replace(/\.md$/, ""), await fs.readFile(path.join(FUNCTIONS_DIR, f), "utf8"))),
  );
  const ord = (fn: string) => { const i = FUNCTION_ORDER.indexOf(fn); return i < 0 ? 99 : i; };
  return cards
    .sort((a, b) => ord(a.slug) - ord(b.slug) || a.title.localeCompare(b.title))
    .map((c) => {
      const owned = specs.filter((s) => s.owner === c.slug);
      const counts: Record<Phase, number> = { planned: 0, in_progress: 0, shipped: 0, rejected: 0 };
      for (const s of owned) counts[s.status]++;
      // "Active" specs under this function = not yet shipped/cut (the live work).
      const active = owned.filter((s) => s.status === "planned" || s.status === "in_progress").length;
      return { ...c, active, counts, specSlugs: c.specSlugs.filter((s) => bySlug.has(s)) };
    });
}

/** One function doc (raw + card + the live specs it owns, grouped by mandate), or null. */
export async function getFunction(slug: string): Promise<
  | { raw: string; card: FunctionCard; ownedSpecs: SpecCard[]; mandateSpecs: Array<{ mandate: Mandate; specs: SpecCard[]; active: number }> }
  | null
> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(FUNCTIONS_DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
  const card = parseFunction(slug, raw);
  const { specs } = await getRoadmap();
  const bySlug = new Map(specs.map((s) => [s.slug, s] as const));
  const ownedSpecs = specs.filter((s) => s.owner === slug);
  const mandateSpecs = card.mandates.map((m) => {
    const resolved = m.specSlugs.map((s) => bySlug.get(s)).filter((x): x is SpecCard => !!x);
    return { mandate: m, specs: resolved, active: resolved.filter((s) => s.status !== "shipped" && s.status !== "rejected").length };
  });
  return { raw, card, ownedSpecs, mandateSpecs };
}

/** All goal cards with their rollup % (advances as linked specs ship). */
export async function getGoals(): Promise<ResolvedGoal[]> {
  const files = await readDir(GOALS_DIR);
  const { specs } = await getRoadmap();
  const bySlug = new Map(specs.map((s) => [s.slug, s] as const));
  const goals = await Promise.all(
    files.map(async (f) => parseGoal(f.replace(/\.md$/, ""), await fs.readFile(path.join(GOALS_DIR, f), "utf8"))),
  );
  return goals
    .map((g) => resolveGoal(g, bySlug))
    .sort((a, b) => a.rollup - b.rollup || a.goal.title.localeCompare(b.goal.title));
}

/** One goal doc (raw + resolved rollup), or null. */
export async function getGoal(slug: string): Promise<{ raw: string; resolved: ResolvedGoal } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  let raw: string;
  try {
    raw = await fs.readFile(path.join(GOALS_DIR, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
  const { specs } = await getRoadmap();
  const bySlug = new Map(specs.map((s) => [s.slug, s] as const));
  return { raw, resolved: resolveGoal(parseGoal(slug, raw), bySlug) };
}
