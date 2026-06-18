#!/usr/bin/env node
/**
 * brain:index — regenerate the two contended brain index files so parallel fold/feature builds never
 * collide on them (docs/brain/specs/fold-build-batching.md Phase 3). Run via `node scripts/brain-index.mjs`
 * (or `npm run brain:index`). Idempotent: a fold-build runs it after writing its per-spec archive entries,
 * and it doubles as the post-merge reconcile on main.
 *
 *  1. docs/brain/archive.md "## Index" — rebuilt from docs/brain/archive.d/*.md (one entry file per
 *     verified/retired spec). Two builds writing different archive.d/{slug}.md files never touch the
 *     same line, so the generated archive.md is the only place the list lives.
 *  2. docs/brain/README.md folder counts — recomputed from the actual *.md file counts per folder, so
 *     a build that adds a brain page never has to hand-edit (and contend on) the count column.
 *
 * Pure Node ESM — no tsx/deps, so it runs in any build worktree.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN = join(REPO, "docs", "brain");
const ARCHIVE_MD = join(BRAIN, "archive.md");
const ARCHIVE_D = join(BRAIN, "archive.d");
const README_MD = join(BRAIN, "README.md");

const mdFiles = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md") : [];

// ── 1. archive.md Index ← archive.d/*.md ────────────────────────────────────
function regenArchive() {
  if (!existsSync(ARCHIVE_D)) {
    console.log("brain:index — no docs/brain/archive.d/; leaving archive.md untouched");
    return;
  }
  const files = mdFiles(ARCHIVE_D);
  // Each archive.d/{slug}.md holds exactly one entry line ("- **Title** · verified DATE · → [[link]]").
  const entries = files
    .map((f) => {
      const line = readFileSync(join(ARCHIVE_D, f), "utf8").split("\n").map((l) => l.trim()).find((l) => l.startsWith("- "));
      if (!line) return null;
      const date = (line.match(/verified\s+(\d{4}-\d{2}-\d{2})/i) || [])[1] || "";
      return { slug: f.replace(/\.md$/, ""), date, line };
    })
    .filter(Boolean)
    // Newest first; deterministic tie-break by slug so the generated file is stable.
    .sort((a, b) => (b.date.localeCompare(a.date)) || a.slug.localeCompare(b.slug));

  const md = readFileSync(ARCHIVE_MD, "utf8");
  const markerM = md.match(/<!--\s*archive-index[^>]*-->/);
  const relIdx = md.indexOf("## Related");
  if (!markerM || relIdx < 0) {
    console.error("brain:index — archive.md missing the <!-- archive-index --> marker or ## Related; skipping archive regen");
    return;
  }
  const head = md.slice(0, markerM.index + markerM[0].length);
  const list = entries.map((e) => e.line).join("\n");
  const next = `${head}\n\n${list}\n\n${md.slice(relIdx)}`;
  if (next !== md) {
    writeFileSync(ARCHIVE_MD, next);
    console.log(`brain:index — archive.md regenerated (${entries.length} entries)`);
  } else {
    console.log(`brain:index — archive.md already current (${entries.length} entries)`);
  }
}

// ── 2. README.md folder counts ← actual file counts ─────────────────────────
// Each row's count column is generated from the folder's *.md count (excluding README). Plain "one page
// per X" folders show the bare number; folders with a README or a settings/ subfolder keep their suffix.
const ROWS = [
  { dir: "tables", fmt: (n) => `${n}` },
  { dir: "inngest", fmt: (n) => `${n}` },
  { dir: "integrations", fmt: (n) => `${n}` },
  { dir: "libraries", fmt: (n) => `${n}` },
  { dir: "lifecycles", fmt: (n) => `${n}` },
  { dir: "journeys", fmt: (n) => `${n} + README` },
  { dir: "playbooks", fmt: (n) => `${n} + README` },
  { dir: "recipes", fmt: (n) => `${n} + README` },
  { dir: "dashboard", fmt: (n) => `${n} + ${mdFiles(join(BRAIN, "dashboard", "settings")).length} settings` },
  { dir: "functions", fmt: (n) => `${n}` },
  { dir: "goals", fmt: (n) => `${n}` },
  { dir: "specs", fmt: (n) => `${n}` },
];

function regenReadme() {
  const lines = readFileSync(README_MD, "utf8").split("\n");
  let changed = 0;
  for (const row of ROWS) {
    // dashboard counts exclude its settings/ subfolder (reported separately in the suffix).
    const n = row.dir === "dashboard"
      ? mdFiles(join(BRAIN, "dashboard")).length
      : mdFiles(join(BRAIN, row.dir)).length;
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
  if (changed) {
    writeFileSync(README_MD, lines.join("\n"));
    console.log(`brain:index — README.md folder counts regenerated (${changed} row(s) updated)`);
  } else {
    console.log("brain:index — README.md folder counts already current");
  }
}

regenArchive();
regenReadme();
