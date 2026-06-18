/**
 * Brain reader — walks docs/brain/** for the /dashboard/brain HTML reader: a folder/file
 * index, a per-doc renderer (marked → prose) with [[wikilink]] resolution between brain pages.
 * Read-only. Vercel: docs/brain/** is traced into the brain routes' bundle (next.config.ts).
 */
import { promises as fs } from "fs";
import path from "path";
import { marked } from "marked";

const BRAIN = path.join(process.cwd(), "docs", "brain");

export interface BrainFile {
  slug: string; // brain-relative path without .md, e.g. "tables/agent_jobs"
  title: string;
  folder: string; // top-level folder, or "(root)"
}

async function walk(dir: string, rel: string, out: BrainFile[]) {
  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const abs = path.join(dir, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      await walk(abs, relPath, out);
    } else if (e.name.endsWith(".md")) {
      const slug = relPath.replace(/\.md$/, "");
      const folder = slug.includes("/") ? slug.slice(0, slug.indexOf("/")) : "(root)";
      let title = slug.split("/").pop()!;
      try {
        const h1 = (await fs.readFile(abs, "utf8")).split("\n").find((l) => l.startsWith("# "));
        if (h1) title = h1.slice(2).replace(/[⏳🚧✅❌]/g, "").trim();
      } catch {
        /* keep filename title */
      }
      out.push({ slug, title, folder });
    }
  }
}

export async function getBrainTree() {
  const files: BrainFile[] = [];
  await walk(BRAIN, "", files);
  files.sort((a, b) => a.slug.localeCompare(b.slug));
  const folders: Record<string, BrainFile[]> = {};
  const byPath: Record<string, BrainFile> = {};
  const byBase: Record<string, string> = {};
  for (const f of files) {
    (folders[f.folder] ||= []).push(f);
    byPath[f.slug] = f;
    const base = f.slug.split("/").pop()!;
    if (!byBase[base]) byBase[base] = f.slug;
  }
  return { files, folders, byPath, byBase };
}

async function getRaw(slug: string): Promise<string | null> {
  if (!/^[a-z0-9/_-]+$/i.test(slug) || slug.includes("..")) return null;
  try {
    return await fs.readFile(path.join(BRAIN, `${slug}.md`), "utf8");
  } catch {
    return null;
  }
}

function resolveWikilink(target: string, currentSlug: string, byPath: Record<string, BrainFile>, byBase: Record<string, string>): string | null {
  const t = target.trim().replace(/\.md$/, "");
  const curDir = currentSlug.includes("/") ? currentSlug.slice(0, currentSlug.lastIndexOf("/")) : "";
  try {
    const rel = path.posix.normalize(path.posix.join(curDir, t));
    if (byPath[rel]) return rel;
  } catch {
    /* fall through */
  }
  const abs = t.replace(/^(\.\.\/)+/, "");
  if (byPath[abs]) return abs;
  const base = abs.split("/").pop()!;
  if (byBase[base]) return byBase[base];
  return null;
}

/** Render a brain doc to HTML, converting [[wikilinks]] to links between brain pages. */
export async function renderBrainDoc(slug: string): Promise<{ slug: string; title: string; html: string } | null> {
  const raw = await getRaw(slug);
  if (raw == null) return null;
  const { byPath, byBase } = await getBrainTree();
  const pre = raw.replace(/\[\[([^\]]+)\]\]/g, (_m, inner: string) => {
    const [tgt, alias] = inner.split("|");
    const resolved = resolveWikilink(tgt, slug, byPath, byBase);
    const label = (alias || tgt.trim().replace(/^.*\//, "").replace(/\.md$/, "")).trim();
    return resolved ? `[${label}](/dashboard/brain/${resolved})` : label;
  });
  const html = await marked.parse(pre);
  const h1 = raw.split("\n").find((l) => l.startsWith("# "));
  const title = h1 ? h1.slice(2).replace(/[⏳🚧✅❌]/g, "").trim() : slug;
  return { slug, title, html };
}
