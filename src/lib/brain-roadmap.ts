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
