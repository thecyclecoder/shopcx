/**
 * Static-analysis check: every `direction: "..."` literal that lives within
 * ~25 lines of a `.from("ticket_messages")` call must be `"inbound"` or
 * `"outbound"` — the only two values permitted by the Postgres
 * `ticket_messages_direction_check` constraint.
 *
 * The failure mode this catches: a call site writes `direction: "internal"`
 * (confusing the row's `direction` axis with its `visibility` axis) or
 * `direction: "in"` (shorthand typo), tsc stays green because the object is
 * loosely typed at the `.insert()` boundary, and the row only fails at prod
 * insert time with a check-constraint violation — exactly the Control Tower
 * error signature `supabase-logs:059613ab926d87eb` that produced the seven
 * Phase 1 fixes. Adding this check moves the class of typo from prod-only
 * observable → build-time hard fail.
 *
 * Heuristic: a `direction:` literal is "scoped to ticket_messages" if the
 * previous `.from("ticket_messages")` call appears within `WINDOW` lines
 * above it. This matches the idiomatic Supabase pattern
 * `.from("ticket_messages").insert({ direction: "..." })` without false-
 * positives on unrelated `direction:` types that co-exist in the same file
 * (deploy-sync `ShaDirection`, media-buyer arm/disarm, etc).
 *
 * Read-only; never mutates state. Mirrors the shape of
 * `scripts/_check-no-klaviyo-calls.ts`.
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const TICKET_MESSAGES_FROM_RE = /\.from\(\s*["']ticket_messages["']\s*\)/;
const DIRECTION_LITERAL_RE = /direction:\s*["']([^"']+)["']/g;
const VALID_DIRECTIONS = new Set(["inbound", "outbound"]);
const WINDOW = 25;
const SCAN_ROOT = "src";
const SCAN_EXTENSIONS = [".ts", ".tsx"];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

function isProseLine(line: string, index: number): boolean {
  const before = line.slice(0, index).replace(/https?:\/\//g, "");
  return before.includes("//") || before.trimStart().startsWith("*");
}

export type InvalidDirectionLiteral = {
  file: string;
  line: number;
  value: string;
  text: string;
};

export function findInvalidTicketMessagesDirections(): InvalidDirectionLiteral[] {
  const violations: InvalidDirectionLiteral[] = [];
  for (const file of walk(SCAN_ROOT)) {
    const rel = file.replace(/^\.\//, "");
    if (rel.includes(".test.")) continue;

    const src = readFileSync(file, "utf8");
    if (!TICKET_MESSAGES_FROM_RE.test(src)) continue;

    const lines = src.split("\n");
    let lastFromLine = -Infinity;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (TICKET_MESSAGES_FROM_RE.test(line)) lastFromLine = i;
      if (i - lastFromLine > WINDOW) continue;

      DIRECTION_LITERAL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DIRECTION_LITERAL_RE.exec(line)) !== null) {
        if (isProseLine(line, m.index)) continue;
        const value = m[1];
        if (VALID_DIRECTIONS.has(value)) continue;
        violations.push({ file: rel, line: i + 1, value, text: line.trim().slice(0, 160) });
      }
    }
  }
  return violations;
}

function main(): void {
  const violations = findInvalidTicketMessagesDirections();
  if (violations.length > 0) {
    console.error(
      `\n❌ check-ticket-messages-direction — ${violations.length} invalid direction literal(s):\n`,
    );
    for (const v of violations) {
      console.error(`   ${v.file}:${v.line}   direction: "${v.value}"`);
      console.error(`      ${v.text}`);
    }
    console.error(
      `\n   The Postgres check constraint ticket_messages_direction_check accepts` +
        `\n   ONLY "inbound" or "outbound". A typo like direction: "internal" is a` +
        `\n   confusion with the visibility axis — visibility carries the` +
        `\n   internal/external audit flag; direction carries the message flow.` +
        `\n   Change the literal to "outbound" (system/agent-authored) or "inbound"` +
        `\n   (customer-authored). See docs/brain/tables/ticket_messages.md.\n`,
    );
    process.exit(1);
  }
  console.log(
    "✅ check-ticket-messages-direction — every direction literal scoped to ticket_messages is inbound|outbound",
  );
}

main();
