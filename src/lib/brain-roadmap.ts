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
const FUNCTIONS_DIR = path.join(process.cwd(), "docs", "brain", "functions");
const GOALS_DIR = path.join(process.cwd(), "docs", "brain", "goals");
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

/**
 * Rewrite [[wikilinks]] in rendered roadmap markdown to dashboard links: spec → /roadmap/{slug},
 * [[../functions/x]] → /roadmap/functions/x, [[../goals/x]] → /roadmap/goals/x. Anything else
 * collapses to its alias/plain text. Used by the spec/function/goal detail pages.
 */
export function linkRoadmapWikilinks(
  md: string,
  sets: { specSlugs?: string[]; functionSlugs?: string[]; goalSlugs?: string[] },
): string {
  const specs = new Set(sets.specSlugs ?? []);
  const fns = new Set(sets.functionSlugs ?? []);
  const goals = new Set(sets.goalSlugs ?? []);
  return md.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [targetRaw, alias] = inner.split("|");
    const t = targetRaw.trim().replace(/\.md$/, "");
    const base = t.replace(/^.*\//, "");
    const label = (alias || base).trim();
    if (/(?:^|\/)functions\//.test(t) || (!t.includes("/") && fns.has(base)))
      return fns.has(base) ? `[${label}](/dashboard/roadmap/functions/${base})` : label;
    if (/(?:^|\/)goals\//.test(t) || (!t.includes("/") && goals.has(base)))
      return goals.has(base) ? `[${label}](/dashboard/roadmap/goals/${base})` : label;
    return specs.has(base) ? `[${label}](/dashboard/roadmap/${base})` : label;
  });
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

// ── Functions + Goals + Mandates: the layers ABOVE a spec (Goal Decomposition Engine) ──
//
// The work hierarchy is Function → (Mandate | Goal) → Spec (docs/brain/project-management.md).
// Functions (docs/brain/functions/*.md) are the permanent org-chart skeleton carrying perpetual
// MANDATES; Goals (docs/brain/goals/*.md) are finite initiatives decomposed into MILESTONES. Both
// live in git markdown, not the DB — these parsers turn them into board data. A goal rolls up to a
// % from its linked specs' phase completion; a mandate is perpetual (no %), surfacing its metric +
// active-spec count instead. See docs/brain/specs/goal-decomposition-engine.md.

/** A perpetual charter a function owns forever — measured by a metric trend, never "done". */
export interface Mandate {
  title: string;
  metric: string; // the **Metric:** line (trend it's judged by); "" if none stated
  specSlugs: string[]; // specs under this mandate (existing spec files only)
  activeSpecCount: number; // linked specs not yet shipped — the "still emitting work" signal
}

/** One director function — the permanent owner of a domain + the home of its mandates + specs. */
export interface FunctionCard {
  slug: string;
  title: string; // H1, "(function)" suffix stripped
  label: string; // display name (acronyms uppercased)
  summary: string; // first paragraph (the charter one-liner)
  mandates: Mandate[];
  goalSlugs: string[]; // goals this function owns/contributes to (from "## Owned … goals")
  specSlugs: string[]; // every spec referenced under any mandate
}

/** A finite chunk of a goal — its own metric + linked specs; rolls up to a % like the goal. */
export interface Milestone {
  id: string; // leading "M0"/"M1" label if present, else the index
  title: string; // the bold milestone name
  detail: string; // prose after the bold name
  status: Phase; // emoji on the milestone line
  specSlugs: string[]; // existing spec files linked under this milestone
  completion: number; // 0..1 rollup (avg of linked specs, else emoji proxy)
}

/** A finite initiative (e.g. CEO mode) decomposed into milestones → specs; closes at 100%. */
export interface GoalCard {
  slug: string;
  title: string;
  outcome: string; // **Outcome:** … (or first paragraph)
  successMetric: string; // **Success metric:** …
  target: string; // **Target:** …
  milestones: Milestone[];
  specSlugs: string[]; // union of every linked spec across milestones
  completion: number; // 0..1 weighted avg of linked specs' phase completion
  status: Phase; // derived from completion / milestone states
}

/** Fraction 0..1 of a spec that's resolved — shipped + cut phases over total, or status fallback. */
export function specCompletion(card: SpecCard): number {
  if (card.status === "shipped") return 1;
  const total = card.phases.length;
  if (!total) return card.status === "in_progress" ? 0.5 : 0;
  return (card.counts.shipped + card.counts.rejected) / total;
}

/** Pull spec slugs from [[../specs/x]] / [[specs/x]] (or bare [[x]] when x is a real spec) in text. */
function specSlugsIn(text: string, validSpecs?: Set<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const t = m[1].trim().replace(/\.md$/, "");
    const pref = t.match(/(?:^|\/)specs\/([a-z0-9-]+)$/i);
    if (pref) { out.push(pref[1]); continue; }
    if (!t.includes("/") && validSpecs?.has(t)) out.push(t);
  }
  return [...new Set(out)];
}

/** Pull goal slugs from [[../goals/x]] / [[goals/x]] wikilinks in text. */
function goalSlugsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const t = m[1].trim().replace(/\.md$/, "");
    const pref = t.match(/(?:^|\/)goals\/([a-z0-9-]+)$/i);
    if (pref) out.push(pref[1]);
  }
  return [...new Set(out)];
}

/** Lines of the `## <heading>` section (heading matched by regex) up to the next `## `. */
function sectionLines(lines: string[], headingRe: RegExp): string[] {
  const start = lines.findIndex((l) => /^##\s/.test(l) && headingRe.test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

/** Value of a `**Key:** value` line found anywhere in the given lines (first wins). */
function fieldValue(lines: string[], key: string): string {
  const re = new RegExp(`\\*\\*${key}:\\*\\*\\s*(.+?)\\s*$`, "i");
  for (const l of lines) {
    const m = l.match(re);
    if (m) return cleanInline(m[1]);
  }
  return "";
}

export function parseFunction(slug: string, raw: string, validSpecs?: Set<string>): FunctionCard {
  const lines = raw.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? cleanInline(titleLine.slice(2)).replace(/\s*\(function\)\s*$/i, "") : functionLabel(slug);

  // Mandates live under "## Mandates" as `### <name>` blocks, each with a **Metric:** + spec wikilinks.
  const mandateLines = sectionLines(lines, /Mandates/i);
  const mandates: Mandate[] = [];
  for (let i = 0; i < mandateLines.length; i++) {
    const h = mandateLines[i].match(/^###\s+(.+)/);
    if (!h) continue;
    const block: string[] = [];
    for (let j = i + 1; j < mandateLines.length && !/^###\s/.test(mandateLines[j]); j++) block.push(mandateLines[j]);
    const specSlugs = specSlugsIn(block.join("\n"), validSpecs);
    mandates.push({
      title: cleanInline(h[1]),
      metric: fieldValue(block, "Metric"),
      specSlugs,
      activeSpecCount: 0, // filled by the caller once spec statuses are known
    });
  }

  const goalSlugs = goalSlugsIn(sectionLines(lines, /goals/i).join("\n"));
  const specSlugs = [...new Set(mandates.flatMap((m) => m.specSlugs))];
  return { slug, title, label: functionLabel(slug), summary: firstParagraph(lines), mandates, goalSlugs, specSlugs };
}

export function parseGoal(slug: string, raw: string, specCards?: Map<string, SpecCard>): GoalCard {
  const lines = raw.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? cleanInline(titleLine.slice(2)) : slug;
  const valid = specCards ? new Set(specCards.keys()) : undefined;

  const compOf = (s: string): number => {
    const c = specCards?.get(s);
    return c ? specCompletion(c) : 0;
  };

  // Milestones: top-level `- ` bullets in "## Decomposition" (each may carry [[spec]] links + an emoji).
  const decomp = sectionLines(lines, /Decomposition/i);
  const milestones: Milestone[] = [];
  for (let i = 0; i < decomp.length; i++) {
    if (!/^-\s/.test(decomp[i])) continue;
    const buf = [decomp[i]];
    for (let j = i + 1; j < decomp.length && !/^-\s/.test(decomp[j]); j++) buf.push(decomp[j]);
    const text = buf.join("\n");
    const bold = decomp[i].match(/\*\*(.+?)\*\*/);
    const rawTitle = bold ? bold[1] : cleanInline(decomp[i].replace(/^-\s*/, ""));
    const id = (rawTitle.match(/^(M\d+)/i) || [])[1] || String(milestones.length);
    const mSpecs = specSlugsIn(text, valid);
    const status = statusFromText(text) ?? "planned";
    const completion = mSpecs.length
      ? mSpecs.reduce((a, s) => a + compOf(s), 0) / mSpecs.length
      : status === "shipped" ? 1 : status === "in_progress" ? 0.5 : 0;
    milestones.push({
      id,
      title: cleanInline(rawTitle).replace(/\.$/, ""),
      detail: cleanInline(decomp[i].replace(/^-\s*/, "").replace(/\*\*.+?\*\*/, "")),
      status,
      specSlugs: mSpecs,
      completion,
    });
  }

  const specSlugs = [...new Set(milestones.flatMap((m) => m.specSlugs))];
  // Rollup: weighted avg of linked specs' phase completion (the spec's definition). When no specs are
  // linked yet (planner hasn't run), fall back to the milestone emoji average so the bar isn't a flat 0.
  const completion = specSlugs.length
    ? specSlugs.reduce((a, s) => a + compOf(s), 0) / specSlugs.length
    : milestones.length
    ? milestones.reduce((a, m) => a + m.completion, 0) / milestones.length
    : 0;
  const status: Phase = completion >= 0.999 ? "shipped" : completion > 0 || milestones.some((m) => m.status === "in_progress") ? "in_progress" : "planned";

  return {
    slug,
    title,
    outcome: fieldValue(lines, "Outcome") || firstParagraph(lines),
    successMetric: fieldValue(lines, "Success metric"),
    target: fieldValue(lines, "Target"),
    milestones,
    specSlugs,
    completion,
    status,
  };
}

async function readDirSlugs(dir: string): Promise<string[]> {
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith(".md") && f !== "README.md").map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

/** Slugs of every function doc — used to resolve [[../functions/x]] wikilinks to /dashboard/roadmap/functions/x. */
export async function listFunctionSlugs(): Promise<string[]> {
  return readDirSlugs(FUNCTIONS_DIR);
}
/** Slugs of every goal doc — used to resolve [[../goals/x]] wikilinks to /dashboard/roadmap/goals/x. */
export async function listGoalSlugs(): Promise<string[]> {
  return readDirSlugs(GOALS_DIR);
}

/** Build a slug→SpecCard map once, so function/goal rollups don't re-read specs per call. */
async function specCardMap(): Promise<Map<string, SpecCard>> {
  const specs = await readSpecs();
  return new Map(specs.map((s) => [s.slug, s]));
}

export async function getFunctions(): Promise<FunctionCard[]> {
  const [slugs, cards] = await Promise.all([listFunctionSlugs(), specCardMap()]);
  const valid = new Set(cards.keys());
  const out = await Promise.all(
    slugs.map(async (slug) => {
      const raw = await fs.readFile(path.join(FUNCTIONS_DIR, `${slug}.md`), "utf8");
      const fn = parseFunction(slug, raw, valid);
      for (const m of fn.mandates) m.activeSpecCount = m.specSlugs.filter((s) => cards.get(s)?.status !== "shipped").length;
      return fn;
    }),
  );
  const ord = (fn: string) => { const i = FUNCTION_ORDER.indexOf(fn); return i < 0 ? 99 : i; };
  return out.sort((a, b) => ord(a.slug) - ord(b.slug) || a.label.localeCompare(b.label));
}

export async function getFunction(slug: string): Promise<{ raw: string; card: FunctionCard } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  try {
    const raw = await fs.readFile(path.join(FUNCTIONS_DIR, `${slug}.md`), "utf8");
    const cards = await specCardMap();
    const card = parseFunction(slug, raw, new Set(cards.keys()));
    for (const m of card.mandates) m.activeSpecCount = m.specSlugs.filter((s) => cards.get(s)?.status !== "shipped").length;
    return { raw, card };
  } catch {
    return null;
  }
}

export async function getGoals(): Promise<GoalCard[]> {
  const [slugs, cards] = await Promise.all([listGoalSlugs(), specCardMap()]);
  const out = await Promise.all(
    slugs.map(async (slug) => parseGoal(slug, await fs.readFile(path.join(GOALS_DIR, `${slug}.md`), "utf8"), cards)),
  );
  // In-progress first, then planned, then closed; stable by title.
  const rank: Record<Phase, number> = { in_progress: 0, planned: 1, shipped: 2, rejected: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title));
}

export async function getGoal(slug: string): Promise<{ raw: string; card: GoalCard } | null> {
  if (!/^[a-z0-9-]+$/i.test(slug)) return null;
  try {
    const raw = await fs.readFile(path.join(GOALS_DIR, `${slug}.md`), "utf8");
    return { raw, card: parseGoal(slug, raw, await specCardMap()) };
  } catch {
    return null;
  }
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
