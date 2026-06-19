/**
 * brain-index — the PURE transform behind the two contended aggregate brain files, extracted so the
 * Inngest runtime can regenerate them out-of-band (docs/brain/specs/brain-index-refresh.md). The box
 * script `scripts/brain-index.mjs` keeps its own zero-dep ESM copy of this same logic for local/manual
 * `npm run brain:index` runs (it must run in any build worktree with bare `node`, no tsx) — keep the two
 * in sync. Folds no longer commit these aggregates; a single scheduled writer does. See:
 *   1. docs/brain/archive.md "## Index" ← docs/brain/archive.d/*.md (one entry file per archived spec)
 *   2. docs/brain/README.md folder counts ← actual *.md file counts per folder
 *
 * Functions here are deterministic string/dir transforms — no GitHub, no network. The caller (the cron)
 * reads the bundled `docs/brain/` tree, regenerates, and commits only a real diff to `main`.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

export interface RegenFile {
  /** Repo-relative path, e.g. `docs/brain/archive.md` — the GitHub Contents API path. */
  path: string;
  /** The freshly regenerated file content. */
  content: string;
}

export interface RegenResult {
  archive: RegenFile | null;
  readme: RegenFile | null;
}

const mdFiles = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md") : [];

// ── 1. archive.md Index ← archive.d/*.md ────────────────────────────────────
/** Rebuild the archive.md "## Index" body from the per-spec archive.d entry files. Returns the new
 *  full archive.md content, or `null` if archive.d/ is absent or the markers are missing (skip). */
function regenArchive(brainDir: string): string | null {
  const archiveMdPath = join(brainDir, "archive.md");
  const archiveDDir = join(brainDir, "archive.d");
  if (!existsSync(archiveDDir) || !existsSync(archiveMdPath)) return null;

  // Each archive.d/{slug}.md holds exactly one entry line ("- **Title** · verified DATE · → [[link]]").
  const entries = mdFiles(archiveDDir)
    .map((f) => {
      const line = readFileSync(join(archiveDDir, f), "utf8")
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("- "));
      if (!line) return null;
      const date = (line.match(/verified\s+(\d{4}-\d{2}-\d{2})/i) || [])[1] || "";
      return { slug: f.replace(/\.md$/, ""), date, line };
    })
    .filter((e): e is { slug: string; date: string; line: string } => e !== null)
    // Newest first; deterministic tie-break by slug so the generated file is stable.
    .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));

  const md = readFileSync(archiveMdPath, "utf8");
  const markerM = md.match(/<!--\s*archive-index[^>]*-->/);
  const relIdx = md.indexOf("## Related");
  if (!markerM || markerM.index === undefined || relIdx < 0) return null;

  const head = md.slice(0, markerM.index + markerM[0].length);
  const list = entries.map((e) => e.line).join("\n");
  return `${head}\n\n${list}\n\n${md.slice(relIdx)}`;
}

// ── 2. README.md folder counts ← actual file counts ─────────────────────────
// Each row's count column is generated from the folder's *.md count (excluding README). Plain "one page
// per X" folders show the bare number; folders with a README or a settings/ subfolder keep their suffix.
type Row = { dir: string; fmt: (n: number) => string };

function readmeRows(brainDir: string): Row[] {
  return [
    { dir: "tables", fmt: (n) => `${n}` },
    { dir: "inngest", fmt: (n) => `${n}` },
    { dir: "integrations", fmt: (n) => `${n}` },
    { dir: "libraries", fmt: (n) => `${n}` },
    { dir: "lifecycles", fmt: (n) => `${n}` },
    { dir: "journeys", fmt: (n) => `${n} + README` },
    { dir: "playbooks", fmt: (n) => `${n} + README` },
    { dir: "recipes", fmt: (n) => `${n} + README` },
    { dir: "dashboard", fmt: (n) => `${n} + ${mdFiles(join(brainDir, "dashboard", "settings")).length} settings` },
    { dir: "functions", fmt: (n) => `${n}` },
    { dir: "goals", fmt: (n) => `${n}` },
    { dir: "specs", fmt: (n) => `${n}` },
  ];
}

/** Recompute the README folder-count column from the actual tree. Returns the new content, or `null`
 *  if README.md is absent. */
function regenReadme(brainDir: string): string | null {
  const readmePath = join(brainDir, "README.md");
  if (!existsSync(readmePath)) return null;

  const lines = readFileSync(readmePath, "utf8").split("\n");
  let changed = 0;
  for (const row of readmeRows(brainDir)) {
    // dashboard counts exclude its settings/ subfolder (reported separately in the suffix).
    const n = mdFiles(join(brainDir, row.dir)).length;
    const want = row.fmt(n);
    const rowRe = new RegExp(`^\\|\\s*\\[${row.dir}/\\]\\(${row.dir}/\\)\\s*\\|`);
    for (let i = 0; i < lines.length; i++) {
      if (!rowRe.test(lines[i])) continue;
      const cells = lines[i].split("|");
      // cells: ['', ' [dir/](dir/) ', ' desc ', ' count ', ''] — count is the last non-empty cell.
      const ci = cells.length - 2;
      if (cells[ci].trim() !== want) {
        cells[ci] = ` ${want} `;
        lines[i] = cells.join("|");
        changed++;
      }
      break;
    }
  }
  return changed ? lines.join("\n") : readFileSync(readmePath, "utf8");
}

/**
 * Regenerate both aggregate files from a `docs/brain/` directory. Returns the new content for each
 * (path + content), or `null` for one that can't be regenerated (missing source/markers). The caller
 * decides whether to commit by diffing each against `main` — this transform never writes or commits.
 */
export function regenerateBrainIndex(brainDir: string): RegenResult {
  const archive = regenArchive(brainDir);
  const readme = regenReadme(brainDir);
  return {
    archive: archive === null ? null : { path: "docs/brain/archive.md", content: archive },
    readme: readme === null ? null : { path: "docs/brain/README.md", content: readme },
  };
}
