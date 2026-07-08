/**
 * Static-analysis check — the playbook-compiler NEVER inserts an active
 * playbook directly (playbook-compiler-becomes-box-agent-mining-full-history
 * Phase 2 verification bullet: "A grep/audit confirms the compiler never
 * inserts an active playbook directly").
 *
 * Scans `src/lib/playbook-compiler.ts` — the sole compiler chokepoint into
 * `playbooks` — and asserts:
 *
 *   (a) every `is_active: true` literal OUTSIDE the sanctioned human-approval
 *       function (`approvePlaybookProposal`) is absent — the seed-insert path
 *       and every payload builder must land is_active=false only.
 *       Comments are stripped before scanning so a docstring calling out the
 *       invariant doesn't false-positive.
 *   (b) `buildProposedPlaybookRow` stamps `is_active: false as const` +
 *       `proposed_by: PLAYBOOK_COMPILER_PROPOSED_BY` — so a seed is
 *       provenance-tagged and the dashboard "Proposed" filter finds it.
 *   (c) `approvePlaybookProposal` DOES flip `is_active: true` — the
 *       human-gated activation path exists (a regression that drops it
 *       would leave seeds permanently proposed).
 *
 * Read-only by construction; exits non-zero on a mismatch so `npm run
 * check:playbook-compiler-no-active` in the `predeploy` chain surfaces a
 * regression at CI time, not in prod after a seed has landed active.
 *
 * Run: `npx tsx scripts/_check-playbook-compiler-no-active.ts`.
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const TARGET = resolve(__dirname, "../src/lib/playbook-compiler.ts");
const APPROVAL_FN = "approvePlaybookProposal";
const BUILDER_FN = "buildProposedPlaybookRow";

function fail(msg: string): never {
  console.error(`\n❌ check-playbook-compiler-no-active — ${msg}\n`);
  process.exit(1);
}

function readTarget(): string {
  try {
    return readFileSync(TARGET, "utf8");
  } catch (e) {
    fail(`could not read ${TARGET}: ${(e as Error).message}`);
  }
}

/** Strip `//` line comments and `/* … *\/` block comments so a docstring
 *  that discusses the invariant doesn't false-positive the scan. Leaves the
 *  code positions intact (comment ranges replaced with same-length spaces)
 *  so line numbers still match. */
function stripComments(src: string): string {
  const out = src.split("");
  let i = 0;
  while (i < src.length) {
    // Line comment (skip the `//` sentinel + everything to the newline)
    if (src[i] === "/" && src[i + 1] === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") {
        out[j] = " ";
        j++;
      }
      i = j;
      continue;
    }
    // Block comment
    if (src[i] === "/" && src[i + 1] === "*") {
      let j = i;
      while (j < src.length - 1 && !(src[j] === "*" && src[j + 1] === "/")) {
        if (src[j] !== "\n") out[j] = " ";
        j++;
      }
      if (j < src.length - 1) {
        out[j] = " ";
        out[j + 1] = " ";
        j += 2;
      }
      i = j;
      continue;
    }
    i++;
  }
  return out.join("");
}

/** Extract the source region of a named `export function <name>(...) [: RT] { ... }`.
 *
 *  The file is prettier-formatted: every top-level function's closing brace
 *  sits on its own line at column 0. That's the anchor we use for the END —
 *  find the first `\n}` after the function's `export` keyword. START is the
 *  `export` line. Simple, robust, works whether the return type contains
 *  object-literal `{...}` shapes or not.
 *
 *  Sanity check: the extracted body must contain the function's opening `{`
 *  followed by code (a stray `\n}` inside a return-type expression before the
 *  body opens would confuse this — but that's not a shape this file uses).
 */
function extractFunctionBody(src: string, name: string): { start: number; end: number; body: string } {
  const re = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`, "g");
  const m = re.exec(src);
  if (!m) fail(`${name} not found in ${TARGET} — Phase-2 function was renamed or removed`);
  const start = m.index;
  // Walk forward looking for a `}\n` at column 0 (i.e. immediately after a
  // `\n`). Since this file is prettier-formatted, every top-level function
  // ends with such a line.
  const closeRe = /\n\}\n/g;
  closeRe.lastIndex = m.index + m[0].length;
  const closeMatch = closeRe.exec(src);
  if (!closeMatch) fail(`${name}: could not find column-0 closing brace after signature`);
  const end = closeMatch.index + 2; // include the `\n}`
  return { start, end, body: src.slice(start, end) };
}

const rawSrc = readTarget();
const src = stripComments(rawSrc);

// Extract the sanctioned approval function's byte range so we can mask it out.
const approval = extractFunctionBody(src, APPROVAL_FN);
const rawApproval = extractFunctionBody(rawSrc, APPROVAL_FN);

// (c) the approval path exists and flips is_active: true — belt on the human-gated activation
if (!/is_active:\s*true\b/.test(rawApproval.body)) {
  fail(`${APPROVAL_FN} no longer flips \`is_active: true\` — the human-gated activation path is missing; compiler seeds would stay permanently proposed`);
}
if (!/proposed_by:\s*null\b/.test(rawApproval.body)) {
  fail(`${APPROVAL_FN} no longer clears \`proposed_by\` on approval — the "Proposed" filter would never lose the row after activation`);
}
if (!/\.eq\("proposed_by",\s*PLAYBOOK_COMPILER_PROPOSED_BY\)/.test(rawApproval.body)) {
  fail(`${APPROVAL_FN} no longer compare-and-sets on proposed_by — a human-authored or already-approved playbook could get reflipped`);
}

// (a) mask the approval-fn range, then scan the rest for `is_active: true`
const maskedSrc = src.slice(0, approval.start) + " ".repeat(approval.end - approval.start) + src.slice(approval.end);
const badRe = /is_active\s*:\s*true\b/g;
const hits = [...maskedSrc.matchAll(badRe)];
if (hits.length > 0) {
  const preview = hits.map((m) => {
    const idx = m.index ?? 0;
    const line = rawSrc.slice(0, idx).split("\n").length;
    return `  line ${line}: ${rawSrc.slice(idx, idx + 40).replace(/\s+/g, " ")}`;
  }).join("\n");
  fail(`src/lib/playbook-compiler.ts contains \`is_active: true\` OUTSIDE the sanctioned ${APPROVAL_FN} — the compiler must NEVER insert an active playbook directly. Hits:\n${preview}`);
}

// (b) the pure builder stamps is_active=false + proposed_by
const builder = extractFunctionBody(rawSrc, BUILDER_FN);
if (!/is_active:\s*false\s+as\s+const/.test(builder.body) && !/is_active:\s*false\b/.test(builder.body)) {
  fail(`${BUILDER_FN} no longer stamps \`is_active: false\` — compiler seeds MUST land in the proposed lane`);
}
if (!/proposed_by:\s*PLAYBOOK_COMPILER_PROPOSED_BY\b/.test(builder.body)) {
  fail(`${BUILDER_FN} no longer stamps \`proposed_by: PLAYBOOK_COMPILER_PROPOSED_BY\` — compiler seeds MUST carry the provenance tag so the dashboard "Proposed" filter can find them`);
}

console.log(
  `✓ check-playbook-compiler-no-active — src/lib/playbook-compiler.ts:\n` +
  `    · zero \`is_active: true\` outside ${APPROVAL_FN}\n` +
  `    · ${BUILDER_FN} stamps { is_active:false, proposed_by:PLAYBOOK_COMPILER_PROPOSED_BY }\n` +
  `    · ${APPROVAL_FN} compare-and-sets on proposed_by + flips is_active/proposed_by`,
);
