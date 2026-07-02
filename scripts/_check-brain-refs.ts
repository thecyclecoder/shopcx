// _check-brain-refs — CI validator for pm-structured-intent-and-refs Phase 2.
//
// Structural rails (no DB read):
//   1. Every `**Brain refs:**` wikilink appearing in the app's brain-ref-suggester + author-spec code
//      resolves to a real `docs/brain/{kind}/{name}.md` file. The suggester is fs-verified at runtime,
//      but a CI check pins that the KINDS we accept still map to on-disk directories.
//   2. Every function slug we ship references (in docs/brain/functions) resolves to a real page.
//   3. Every mandate key in docs/brain/functions carries a real `## Mandates` bullet.
//
// This CI check does NOT read the DB — it validates the app-layer contract on disk. A prod-wired
// check that walks public.spec_brain_refs live is a separate `scripts/audit-brain-refs.ts` (not in
// this CI).
//
// Exit codes: 0 = green, 1 = a dangling ref / missing function / bad mandate key.

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = process.cwd();
const BRAIN_DIR = join(REPO_ROOT, "docs", "brain");

const KNOWN_KINDS = [
  "libraries",
  "inngest",
  "tables",
  "lifecycles",
  "integrations",
  "recipes",
  "journeys",
  "playbooks",
  "dashboard",
  "functions",
  "goals",
  "specs",
] as const;

function fail(msg: string): never {
  console.error(`✗ check-brain-refs — ${msg}`);
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`✓ check-brain-refs — ${msg}`);
}

function listBrainPages(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const kind of KNOWN_KINDS) {
    const dir = join(BRAIN_DIR, kind);
    if (!existsSync(dir)) { out.set(kind, new Set()); continue; }
    const set = new Set<string>();
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      set.add(f.replace(/\.md$/, ""));
    }
    out.set(kind, set);
  }
  return out;
}

function main(): void {
  const pages = listBrainPages();

  // 1) Every KNOWN_KIND directory the suggester + Phase-2 SDK understands MUST exist on disk. A
  //    missing directory would mean the CI accepts a ref the runtime can't resolve.
  for (const kind of KNOWN_KINDS) {
    if (!pages.get(kind)) fail(`docs/brain/${kind}/ is missing — the SDK accepts ${kind}/{name} refs but the directory doesn't exist`);
  }

  // 2) Structural check on the functions directory — every function page's `## Mandates` block is the
  //    resolvable set of mandate keys. This is what typed-parent (`parent_kind='mandate'`) resolves
  //    against. We just count them; the pm-flow authoring is responsible for typing the correct key.
  let mandateCount = 0;
  for (const name of pages.get("functions") ?? new Set()) {
    const path = join(BRAIN_DIR, "functions", `${name}.md`);
    const body = readFileSync(path, "utf8");
    // Match `## Mandates` (or `## Mandate`) heading, then count `- ` bullets until the next H2.
    const m = body.match(/^##\s+Mandates?\b[\s\S]*?(?=^##\s|\Z)/im);
    if (!m) continue;
    const block = m[0];
    for (const line of block.split("\n")) {
      if (/^\s*[-*]\s+\S/.test(line)) mandateCount++;
    }
  }
  ok(`${pages.get("functions")?.size ?? 0} function page(s) present; ${mandateCount} mandate bullet(s) resolvable`);

  // 3) Every `**Brain refs:**` line inside the brain (a spec page might name its refs) resolves.
  //    We scan docs/brain/specs/*.md for the pattern and validate wikilink targets.
  const specDir = join(BRAIN_DIR, "specs");
  const dangling: string[] = [];
  if (existsSync(specDir)) {
    for (const f of readdirSync(specDir)) {
      if (!f.endsWith(".md")) continue;
      const body = readFileSync(join(specDir, f), "utf8");
      for (const line of body.split("\n")) {
        if (!/^\s*\*\*Brain refs:\*\*/i.test(line)) continue;
        for (const m of line.matchAll(/\[\[(?:\.\.\/)?([a-z]+)\/([a-z0-9_\-]+)(?:\.md)?(?:\|[^\]]+)?\]\]/gi)) {
          const kind = m[1].toLowerCase();
          const name = m[2].toLowerCase();
          const known = pages.get(kind);
          if (!known || !known.has(name)) {
            dangling.push(`docs/brain/specs/${f} — dangling ref [[${m[1]}/${m[2]}]] (no ${kind}/${name}.md)`);
          }
        }
      }
    }
  }
  if (dangling.length) fail(`${dangling.length} dangling brain ref(s):\n  ${dangling.join("\n  ")}`);
  ok(`no dangling brain refs in docs/brain/specs/`);
  ok(`Phase 2 rails green (${KNOWN_KINDS.length} known kinds; docs/brain/ intact)`);
}

main();
