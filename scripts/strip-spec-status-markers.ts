// strip-spec-status-markers — spec-status-db-driven Phase 3 one-time content migration.
//
// Strips status emoji from every docs/brain/specs/*.md so the markdown carries CONTENT only — title,
// phase titles, owner, parent, blockedBy, autoBuild, repairSignature, summary, verification. Status /
// critical / deferred now live in `spec_card_state` (DB) authoritatively, so the markdown markers are
// redundant noise. Stripped:
//
//   - H1 status emoji:      `# Title ⏳/🚧/✅` → `# Title`
//   - Phase status emoji:   `## Phase N — title ⏳/🚧/✅` → `## Phase N — title`
//   - Phase-bullet emoji:   `- ⏳ **P1:** …` → `- **P1:** …`
//   - **Deferred:** marker line (and its leading blank line)
//   - **Priority:** critical marker line (and its leading blank line)
//   - Verification bullet leading ✅: `- ✅ On …` → `- On …`
//
// Idempotent. Two-phase: dry run by default, `--apply` writes.
//
//   npx tsx scripts/strip-spec-status-markers.ts            # dry run
//   npx tsx scripts/strip-spec-status-markers.ts --apply    # write
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const APPLY = process.argv.includes("--apply");
const SPECS_DIR = resolve(__dirname, "../docs/brain/specs");

const EMOJI = /[⏳🚧✅❌]/g;

function stripH1(lines: string[]): { lines: string[]; changed: boolean } {
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("# ")) continue;
    const stripped = lines[i].replace(EMOJI, "").replace(/\s+$/, "");
    if (stripped !== lines[i]) {
      lines[i] = stripped;
      changed = true;
    }
    break;
  }
  return { lines, changed };
}

function stripPhaseHeadings(lines: string[]): { lines: string[]; changed: boolean } {
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (!/^#{2,3}\s+Phase\b/.test(lines[i])) continue; // H2 (## Phase) OR H3 (### Phase under ## Phases)
    const stripped = lines[i].replace(EMOJI, "").replace(/\s+$/, "");
    if (stripped !== lines[i]) {
      lines[i] = stripped;
      changed = true;
    }
  }
  return { lines, changed };
}

function stripPhaseBullets(lines: string[]): { lines: string[]; changed: boolean } {
  let changed = false;
  let inPhases = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Phases?\s*$/i.test(lines[i])) { inPhases = true; continue; }
    if (inPhases && lines[i].startsWith("## ")) { inPhases = false; continue; }
    if (!inPhases) continue;
    const m = lines[i].match(/^(\s*[-*]\s+)[⏳🚧✅❌]\s+(.*)$/);
    if (m) {
      lines[i] = `${m[1]}${m[2]}`;
      changed = true;
    }
  }
  return { lines, changed };
}

function stripMarkerLine(lines: string[], re: RegExp): { lines: string[]; changed: boolean } {
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      if (out.length && out[out.length - 1].trim() === "") out.pop();
      changed = true;
      continue;
    }
    out.push(lines[i]);
  }
  return { lines: out, changed };
}

function stripVerificationGreen(lines: string[]): { lines: string[]; changed: boolean } {
  let changed = false;
  let inVerification = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Verification\b/i.test(lines[i])) { inVerification = true; continue; }
    if (inVerification && lines[i].startsWith("## ")) { inVerification = false; continue; }
    if (!inVerification) continue;
    const m = lines[i].match(/^(- )✅\s+(.*)$/);
    if (m) {
      lines[i] = `${m[1]}${m[2]}`;
      changed = true;
    }
  }
  return { lines, changed };
}

function stripAll(raw: string): { out: string; changed: boolean } {
  let lines = raw.split("\n");
  let changed = false;
  let r = stripH1(lines); lines = r.lines; changed = changed || r.changed;
  r = stripPhaseHeadings(lines); lines = r.lines; changed = changed || r.changed;
  r = stripPhaseBullets(lines); lines = r.lines; changed = changed || r.changed;
  r = stripMarkerLine(lines, /^\s*\*\*Deferred:\*\*/i); lines = r.lines; changed = changed || r.changed;
  r = stripMarkerLine(lines, /^\s*\*\*Priority:\*\*\s*critical\b/i); lines = r.lines; changed = changed || r.changed;
  r = stripMarkerLine(lines, /^\s*\*\*Status:\*\*\s*deferred\b/i); lines = r.lines; changed = changed || r.changed;
  r = stripVerificationGreen(lines); lines = r.lines; changed = changed || r.changed;
  return { out: lines.join("\n"), changed };
}

function main() {
  const files = readdirSync(SPECS_DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
  let touched = 0;
  for (const f of files) {
    const path = resolve(SPECS_DIR, f);
    const raw = readFileSync(path, "utf8");
    const { out, changed } = stripAll(raw);
    if (!changed) continue;
    touched++;
    console.log(`  ${f}: status markers stripped`);
    if (APPLY) writeFileSync(path, out);
  }
  console.log(`\n${touched} spec(s) ${APPLY ? "stripped" : "would be stripped"} of ${files.length} total`);
  if (!APPLY) console.log("(dry run — pass --apply to write)");
}

main();
