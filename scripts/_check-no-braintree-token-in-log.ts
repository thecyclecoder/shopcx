/**
 * Static-analysis check: the portal remove-payment-method handler MUST NOT
 * interpolate the vaulted Braintree payment-method token into any log output.
 *
 * Card-removal Phase 3. The security review of the first build flagged
 * `String(pm.braintree_payment_method_token).slice(0, 8)` inside the Braintree
 * delete `catch` block as a credential leak — the token is a charge/delete
 * credential and even a prefix of it is credential material. The remediation
 * removed the interpolation; this check pins it so a future edit does not
 * quietly reintroduce it (e.g. by copy-pasting the old log line back for
 * "extra context").
 *
 * The rule: inside `src/lib/portal/handlers/remove-payment-method.ts`, the
 * substring `braintree_payment_method_token` MUST NOT appear inside any
 * BACKTICK TEMPLATE LITERAL. The token may still be READ from the row (a bare
 * property access `pm.braintree_payment_method_token`) and PASSED to
 * `gateway.paymentMethod.delete(...)` — the vault call is the only legitimate
 * destination. The forbidden shape is any log-line-shaped
 * `` `... ${...braintree_payment_method_token...}` `` template literal.
 *
 * Read-only; never mutates state. Wired into `npm run check:no-braintree-token-in-log`
 * + chained into `predeploy:static`.
 *
 * Run:  npx tsx scripts/_check-no-braintree-token-in-log.ts   # exits 1 on any violation
 */
import { readFileSync } from "fs";
import { join, relative } from "path";

const REPO_ROOT = join(__dirname, "..");
const TARGET_REL = "src/lib/portal/handlers/remove-payment-method.ts";
const TOKEN_FIELD = "braintree_payment_method_token";

/**
 * Extract every backtick-delimited template literal in `text`, returning
 * `{ start, end, body }` per literal. Skips backticks inside line comments,
 * block comments, and non-template string literals ('...' / "..."). Handles
 * `${...}` interpolations by tracking brace depth and re-entering the
 * template-literal state on the closing `}`. Nested templates via
 * interpolations are handled recursively (a template inside `${...}` opens
 * its own scan).
 */
function findTemplateLiterals(
  text: string,
): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  let i = 0;
  const N = text.length;
  const templateStack: number[] = []; // depth of `${` interpolations for each open template
  let inLine = false;
  let inBlock = false;
  let inStr: '"' | "'" | null = null;
  let templateStart = -1;
  let inTemplate = false;
  let braceDepthInInterp = 0;

  while (i < N) {
    const ch = text[i];
    const nch = text[i + 1];

    if (inLine) {
      if (ch === "\n") inLine = false;
      i++;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && nch === "/") { inBlock = false; i += 2; continue; }
      i++;
      continue;
    }
    if (inStr) {
      if (ch === "\\") { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }

    if (!inTemplate) {
      // Not inside a template — look for entry points.
      if (ch === "/" && nch === "/") { inLine = true; i += 2; continue; }
      if (ch === "/" && nch === "*") { inBlock = true; i += 2; continue; }
      if (ch === '"' || ch === "'") { inStr = ch as '"' | "'"; i++; continue; }
      if (ch === "`") {
        inTemplate = true;
        templateStart = i;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // Inside a template literal.
    if (braceDepthInInterp > 0) {
      // Inside `${...}` — recurse structurally.
      if (ch === "\\") { i += 2; continue; }
      if (ch === "/" && nch === "/") { inLine = true; i += 2; continue; }
      if (ch === "/" && nch === "*") { inBlock = true; i += 2; continue; }
      if (ch === '"' || ch === "'") { inStr = ch as '"' | "'"; i++; continue; }
      if (ch === "`") {
        // Nested template inside interpolation — push current template.
        templateStack.push(braceDepthInInterp);
        // Save outer template start? We only record OUTER templates once they
        // close, so keep templateStart pointing at the outer one and open a
        // second template scan without losing state — simpler: record the
        // outer one now (up to the nested backtick) and restart on close.
        // For our narrow rule (searching the substring TOKEN_FIELD anywhere in
        // any template body), we can just concatenate — descend into the
        // nested template as if it were a fresh top-level template.
        // Push outer template context onto the stack:
        // simplification — treat nested templates as a separate scan.
        // Record outer template so far and reset:
        out.push({ start: templateStart, end: i - 1, body: text.slice(templateStart + 1, i) });
        inTemplate = true;
        templateStart = i;
        braceDepthInInterp = 0;
        i++;
        continue;
      }
      if (ch === "{") { braceDepthInInterp++; i++; continue; }
      if (ch === "}") {
        braceDepthInInterp--;
        i++;
        continue;
      }
      i++;
      continue;
    }

    // Inside a template, NOT inside `${...}`.
    if (ch === "\\") { i += 2; continue; }
    if (ch === "$" && nch === "{") {
      braceDepthInInterp = 1;
      i += 2;
      continue;
    }
    if (ch === "`") {
      out.push({ start: templateStart, end: i, body: text.slice(templateStart + 1, i) });
      inTemplate = false;
      templateStart = -1;
      // Pop nested template context if any — for our simplified nested handling
      // we don't push, so nothing to pop.
      i++;
      continue;
    }
    i++;
  }
  return out;
}

function lineOf(text: string, idx: number): number {
  let line = 1;
  const cap = Math.min(idx, text.length);
  for (let i = 0; i < cap; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function main() {
  const abs = join(REPO_ROOT, TARGET_REL);
  const text = readFileSync(abs, "utf8");

  const templates = findTemplateLiterals(text);
  const violations: Array<{ line: number; snippet: string }> = [];
  for (const t of templates) {
    if (t.body.includes(TOKEN_FIELD)) {
      const line = lineOf(text, t.start);
      const snippet = text.slice(t.start, t.end + 1).replace(/\s+/g, " ").slice(0, 200);
      violations.push({ line, snippet });
    }
  }

  if (violations.length > 0) {
    console.error(
      `\n❌ check-no-braintree-token-in-log — ${violations.length} template literal(s) in ${TARGET_REL} reference the vaulted Braintree token:\n`,
    );
    for (const v of violations) {
      console.error(`  • ${TARGET_REL}:${v.line}`);
      console.error(`      ${v.snippet}`);
    }
    console.error(
      `\nThe vaulted Braintree payment-method token is a charge/delete credential and\n` +
      `MUST NOT be interpolated into any log output — not even a prefix, per the\n` +
      `Phase 3 security-review remediation of the card-removal spec. Read the token\n` +
      `into a local binding if you need it as a delete argument, but keep it OUT of\n` +
      `every template-literal log line. Log only non-secret identifiers instead:\n` +
      `the local customer_payment_methods row id, the workspace id, and a sanitized\n` +
      `error message via errText(e) from @/lib/error-text.\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-no-braintree-token-in-log — ${relative(REPO_ROOT, abs)}: 0 template literal(s) reference the vaulted token.`,
  );
}

main();
