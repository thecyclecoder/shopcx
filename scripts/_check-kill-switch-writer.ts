/**
 * Static-analysis check: the documented kill-switch writer exists AND is the ONLY writer.
 * ([[../docs/brain/specs/a-kill-switch-can-always-be-turned-back-on.md]] Phase 2)
 *
 * [[../docs/brain/tables/kill_switches.md]] names `POST /api/developer/control-tower/switch` as the
 * CEO-only writer and states 'Nothing else — no director, no worker, no cron — writes here'. For a
 * month the docs said that while no code in `src/` or `scripts/` wrote the table at all — a founder
 * flipped `ad-creative` off on 2026-07-15 for a retool freeze and the row survived to 2026-08-18
 * because nothing in the product could clear it. This guard makes the claim self-checking:
 *
 *   (a) POSITIVE ASSERTION — the documented route file exists AND exports an async POST handler.
 *       Deleting the route (or renaming it) fails the build with a named offender.
 *   (b) NEGATIVE ASSERTION — no other `.ts`/`.tsx` under `src/` + `scripts/` performs an
 *       insert / update / upsert / delete against `public.kill_switches`. A second writer
 *       re-opens the CEO-only hole the table's invariants forbid.
 *
 * SCAN SCOPE for (b): every `.ts`/`.tsx` under `src/` + `scripts/` (excluding node_modules /
 * dotdirs). Writes are detected by a `.from("kill_switches")` match followed within a 12-line
 * window by `.insert(` / `.update(` / `.upsert(` / `.delete(` — the shape every Supabase write
 * takes on this table. Reads (`.select(...)`) are OK and don't trigger.
 *
 * SANCTIONED WRITER (allowlist): only the route file above. An explicit allowlist is provided so a
 * legitimate second caller — if one ever appears — can be added with a written justification,
 * tightening the guard rather than deleting it.
 *
 * Mirrors [[./_check-competitors-sdk-compliance.ts]]. Wired into `npm run
 * check:kill-switch-writer` + chained into `predeploy:static`. Read-only; never mutates.
 *
 * Run:  npx tsx scripts/_check-kill-switch-writer.ts            # exits 1 on any finding
 *       npx tsx scripts/_check-kill-switch-writer.ts --summary  # one-line-per-finding view
 */
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/** Repo root — this file lives at <root>/scripts/_check-kill-switch-writer.ts. */
const REPO_ROOT = join(__dirname, "..");

/** The documented CEO-only writer route file (positive assertion). */
const SANCTIONED_ROUTE = "src/app/api/developer/control-tower/switch/route.ts";

/**
 * Files allowed to issue a `.from("kill_switches")` write. Only the sanctioned route belongs
 * here; add a new entry with a WRITTEN JUSTIFICATION comment when a legitimate second caller
 * appears. The compliance script itself is excluded — its docstring references the write-verb
 * pattern in prose which the regex would otherwise flag on itself.
 */
const WRITE_ALLOWLIST = new Set<string>([
  SANCTIONED_ROUTE,
  "scripts/_check-kill-switch-writer.ts",
]);

/** Table under guard. */
const TABLE = "kill_switches";

/** Write-verb Supabase methods that mutate the row-set. */
const WRITE_VERBS = ["insert", "update", "upsert", "delete"] as const;

/* ------------------------------------------------------------------------------------------------
 * Scope resolution.
 * --------------------------------------------------------------------------------------------- */

/** Recursively collect `*.ts(x)` files under a dir (skips node_modules / dotdirs). */
function walkTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkTs(full));
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** Every file in scan scope (src/** + scripts/**), de-duped + sorted. */
function scanFiles(): string[] {
  const files = new Set<string>();
  for (const f of walkTs(join(REPO_ROOT, "src"))) files.add(f);
  for (const f of walkTs(join(REPO_ROOT, "scripts"))) files.add(f);
  return [...files].sort();
}

/* ------------------------------------------------------------------------------------------------
 * Positive assertion — the sanctioned route file exists and exports a POST handler.
 * --------------------------------------------------------------------------------------------- */

/** Returns an error message if the sanctioned route is missing or does not export a POST handler. */
function assertSanctionedRoute(): string | null {
  const abs = join(REPO_ROOT, SANCTIONED_ROUTE);
  if (!existsSync(abs)) {
    return `SANCTIONED ROUTE MISSING — ${SANCTIONED_ROUTE} does not exist. ` +
      `docs/brain/tables/kill_switches.md names this as the CEO-only writer; without it the ` +
      `table has NO writer and a switched-off node cannot be turned back on without a raw ` +
      `service-role delete (the exact bypass this spec exists to eliminate).`;
  }
  const text = readFileSync(abs, "utf8");
  // Next.js App-Router POST handler — either `export async function POST(` or the aliased
  // `export const POST =` / `export { POST }` forms. Accept any of them.
  const hasPost =
    /export\s+async\s+function\s+POST\s*\(/.test(text) ||
    /export\s+function\s+POST\s*\(/.test(text) ||
    /export\s+const\s+POST\s*=/.test(text) ||
    /export\s*\{[^}]*\bPOST\b[^}]*\}/.test(text);
  if (!hasPost) {
    return `SANCTIONED ROUTE MISSING POST HANDLER — ${SANCTIONED_ROUTE} exists but does not ` +
      `export a POST handler. The route is the only writer; without POST there is no way to ` +
      `set OR clear a kill switch.`;
  }
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Negative assertion — no unsanctioned writes to `public.kill_switches`.
 * --------------------------------------------------------------------------------------------- */

interface WriteFinding {
  file: string;
  line: number;
  verb: string;
  snippet: string;
}

const FROM_RE = new RegExp(`\\.from\\(\\s*["'\`]${TABLE}["'\`]\\s*\\)`, "g");
/** Window (in lines) after a `.from("kill_switches")` match to scan for a write verb. Wide enough
 *  to catch a chained builder split across multiple lines (the typical Supabase call shape). */
const CHAIN_WINDOW = 12;

/** Scan one file's text for `.from("kill_switches").{insert|update|upsert|delete}(...)` chains. */
function findUnsanctionedWrites(rel: string, text: string): WriteFinding[] {
  const lines = text.split("\n");
  const out: WriteFinding[] = [];
  let m: RegExpExecArray | null;
  FROM_RE.lastIndex = 0;
  while ((m = FROM_RE.exec(text)) !== null) {
    const matchLine = text.slice(0, m.index).split("\n").length; // 1-based
    // Slice a CHAIN_WINDOW-line window starting at the .from(...) line, and look for a write verb
    // on any line within it. A read chain uses `.select(...)` so it won't match.
    const windowLines = lines.slice(matchLine - 1, matchLine - 1 + CHAIN_WINDOW);
    for (let i = 0; i < windowLines.length; i++) {
      const ln = windowLines[i];
      for (const verb of WRITE_VERBS) {
        if (new RegExp(`\\.${verb}\\s*\\(`).test(ln)) {
          out.push({
            file: rel,
            line: matchLine + i,
            verb,
            snippet: (ln ?? "").trim().slice(0, 160),
          });
          // One finding per .from() chain is enough — a chain with both an .insert AND a chained
          // .update is still a single violation, and reporting them all would be noisy.
          break;
        }
      }
    }
  }
  // De-dup by (file, line) — the outer loop can flag the same write once per match; take the first.
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.file}:${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ------------------------------------------------------------------------------------------------
 * Main.
 * --------------------------------------------------------------------------------------------- */

function main() {
  const summary = process.argv.includes("--summary");

  // (a) POSITIVE ASSERTION.
  const missing = assertSanctionedRoute();

  // (b) NEGATIVE ASSERTION.
  const files = scanFiles();
  const findings: WriteFinding[] = [];
  for (const abs of files) {
    const rel = relative(REPO_ROOT, abs).split("\\").join("/");
    if (WRITE_ALLOWLIST.has(rel)) continue;
    const text = readFileSync(abs, "utf8");
    findings.push(...findUnsanctionedWrites(rel, text));
  }

  if (summary) {
    console.log(
      `kill-switch-writer — sanctioned route ${missing ? "MISSING" : "OK"} · ` +
      `${files.length} file(s) scanned · ${findings.length} unsanctioned write finding(s)`,
    );
    for (const f of findings) console.log(`  [VIOLATION] ${f.file}:${f.line}  .${f.verb}(  ${f.snippet}`);
  }

  const fatal = !!missing || findings.length > 0;

  if (missing) {
    console.error(`\n❌ check-kill-switch-writer — ${missing}\n`);
  }
  if (findings.length > 0) {
    console.error(
      `\n❌ check-kill-switch-writer — ${findings.length} unsanctioned write(s) to \`public.${TABLE}\`:\n`,
    );
    for (const f of findings) {
      console.error(`  • ${f.file}:${f.line}  →  .${f.verb}(  ${f.snippet}`);
    }
    console.error(
      `\n\`public.${TABLE}\` is CEO-only per docs/brain/tables/kill_switches.md. The ONE writer is\n` +
      `\`POST /api/developer/control-tower/switch\` (${SANCTIONED_ROUTE}) — it gates on the workspace\n` +
      `owner seat above the DB. A second writer re-opens the hole the table's invariants forbid.\n` +
      `Either retarget the call through that route, or add the file to WRITE_ALLOWLIST in\n` +
      `scripts/_check-kill-switch-writer.ts with a written justification.\n`,
    );
  }
  if (fatal) process.exit(1);

  console.log(
    `✓ check-kill-switch-writer — sanctioned route present; ${files.length} file(s) scanned; 0 unsanctioned writes to \`public.${TABLE}\`.`,
  );
}

main();
