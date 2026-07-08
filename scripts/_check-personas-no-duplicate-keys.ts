/**
 * Static-analysis check: NO duplicate `PERSONAS` record keys in `src/lib/agents/personas.ts`.
 *
 * Phase 1 of docs/brain/specs/builder-persona-add-upserts-by-key-and-generates-avatar.md. A duplicate
 * literal key in a TypeScript object literal breaks `tsc --noEmit` with TS1117 ("An object literal
 * cannot have multiple properties with the same name"), so a build that appends a second entry with
 * an already-taken key fails EVERY subsequent build's tsc gate — the 2026-07-07 prompt-review
 * incident (Prue dup on top of Wren → TS1117 on main → dead build queue until 6777fb895 dedupe).
 *
 * The guard scans the ONE `PERSONAS` record literal in `src/lib/agents/personas.ts` for repeated
 * top-level keys (quoted and bareword) and CI-reds any duplicate — a hard rail catching an
 * accidental append when the builder's persona-add step forgets to upsert.
 *
 * Read-only; never mutates state. Runs in `predeploy` so a builder PR that would break tsc gets
 * caught at the guard before it merges.
 *
 * Run:  npx tsx scripts/_check-personas-no-duplicate-keys.ts
 */
import { readFileSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");
const PERSONAS_FILE = "src/lib/agents/personas.ts";

/**
 * Extract the top-level keys of the `PERSONAS: Record<string, AgentPersona>` object literal from
 * personas.ts. We match the record's opening + walk the source, counting brace depth so nested
 * object literals (the persona bodies) don't leak keys of their own. At depth-1 inside PERSONAS,
 * a `<key>: {` on its own line is a persona entry — record it, report line + column.
 */
interface PersonaKey {
  key: string;
  line: number;
}

function extractPersonasKeys(source: string): PersonaKey[] {
  const startRe = /export\s+const\s+PERSONAS\s*:\s*Record<[^>]+>\s*=\s*\{/;
  const startMatch = startRe.exec(source);
  if (!startMatch) {
    throw new Error(`could not find \`export const PERSONAS: Record<…> = {\` in ${PERSONAS_FILE}`);
  }
  // Line number of the opening brace of PERSONAS
  const openIdx = startMatch.index + startMatch[0].length - 1; // position of the `{`
  let depth = 0;
  let cursor = openIdx;
  // Walk forward until the matching close brace of PERSONAS
  const keys: PersonaKey[] = [];
  // Track newline indices to compute line numbers cheaply.
  const lineFor = (idx: number): number => source.slice(0, idx).split("\n").length;
  // A top-level entry looks like: `<bareword>: {` OR `"<quoted>": {` on its own line, at depth-1
  // (i.e. right after PERSONAS's opening brace, before any nested persona body has opened).
  const entryRe = /^\s*(?:(["'])([^"']+)\1|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*\{/;
  while (cursor < source.length) {
    const ch = source[cursor];
    if (ch === "{") {
      depth++;
      if (depth === 1) {
        // We just entered PERSONAS. Scan line by line looking for entry openers at this depth.
        // Advance to the next newline to start scanning at line boundaries.
        cursor++;
        continue;
      }
      // Depth > 1 → we're inside a persona body; skip until we close back to depth 1.
      cursor++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) break; // closed PERSONAS
      cursor++;
      continue;
    }
    if (depth === 1 && ch === "\n") {
      // We're between persona entries — the next non-whitespace should be either a `<key>: {` line
      // or a comment. Grab the line and try to match an entry opener.
      const nextNl = source.indexOf("\n", cursor + 1);
      const line = source.slice(cursor + 1, nextNl === -1 ? source.length : nextNl);
      const m = entryRe.exec(line);
      if (m) {
        const key = m[2] ?? m[3];
        keys.push({ key, line: lineFor(cursor + 1) });
      }
    }
    cursor++;
  }
  return keys;
}

function main() {
  const abs = join(REPO_ROOT, PERSONAS_FILE);
  const source = readFileSync(abs, "utf8");
  const entries = extractPersonasKeys(source);

  if (entries.length === 0) {
    console.error(`❌ check-personas-no-duplicate-keys — parsed 0 PERSONAS entries from ${PERSONAS_FILE} (parser drift?)`);
    process.exit(1);
  }

  const byKey = new Map<string, number[]>();
  for (const e of entries) {
    const lines = byKey.get(e.key) ?? [];
    lines.push(e.line);
    byKey.set(e.key, lines);
  }

  const dups = [...byKey.entries()].filter(([, lines]) => lines.length > 1);
  if (dups.length > 0) {
    console.error(`\n❌ check-personas-no-duplicate-keys — ${dups.length} duplicate PERSONAS key(s) in ${PERSONAS_FILE}:\n`);
    for (const [key, lines] of dups) {
      console.error(`  • "${key}" appears at line(s) ${lines.join(", ")}`);
    }
    console.error(
      `\nA duplicate literal key in the PERSONAS object literal fails \`tsc --noEmit\` with TS1117\n` +
      `("An object literal cannot have multiple properties with the same name") — every subsequent\n` +
      `build's tsc gate fails until a human dedupes. When the builder adds a persona whose key\n` +
      `already exists, it MUST REPLACE the existing entry (upsert) instead of appending a second.\n`,
    );
    process.exit(1);
  }

  console.log(`✓ check-personas-no-duplicate-keys — ${entries.length} PERSONAS entries in ${PERSONAS_FILE}; 0 duplicates.`);
}

main();
