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
