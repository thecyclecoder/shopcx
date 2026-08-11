/**
 * check-ticket-direction-path-drift — the predeploy standing guard against the
 * `TicketDirectionPath` TypeScript union and the `public.ticket_direction_path`
 * Postgres enum drifting apart ([[../docs/brain/specs/ticket-direction-path-workflow-enum-drift]]
 * Phase 2).
 *
 * The bug this catches: Sol's Direction writer validates `chosen_path` against the TS union,
 * then inserts the row. When one side of the drift adds a value the other doesn't have — the
 * TS union gained `'workflow'` but the DB enum never did — every Sol session that picks that
 * path dies on the insert with the entire ticket falling through to the no-progress circuit.
 * Three Sol sessions were killed this way (2026-07-28, 2026-08-04, 2026-08-05) before Phase 1
 * added the enum value; Phase 2 is the rail so the next path added to one can never silently
 * miss the other.
 *
 * The check:
 *   1. Parse the `TicketDirectionPath` union members out of `src/lib/ticket-directions.ts` —
 *      read the source text and extract the quoted members, so this file needs no runtime import.
 *   2. Read the live enum labels for `public.ticket_direction_path` (pg_enum join pg_type, via
 *      the read-only pooler client from `_bootstrap`).
 *   3. Union the live labels with every `ALTER TYPE (public.)?ticket_direction_path ADD VALUE
 *      '<x>'` label committed under `supabase/migrations/` — this covers the co-shipped case
 *      where a migration that adds a new path is in the same PR as the TS union that names it
 *      (the migration hasn't run yet at pre-merge predeploy time; `applyMergedMigrations` runs
 *      it post-merge). Without this the guard would perma-red every co-shipped enum bump.
 *   4. Diff both directions. Exit 1 with a line-numbered message naming each offender:
 *      `in the TS union but not the enum` / `in the enum but not the TS union`. Exit 0 when
 *      they match.
 *
 * READ-ONLY. When the DB is unreachable (a CI-lite context without pooler creds) SKIPS with a
 * clear message and exits 0 — mirrors [[./_check-phantom-shipped-phases]]. The box worker's
 * predeploy has the env; a plain `npm i` CI does not, and forcing a red there would break every
 * unrelated PR without adding signal.
 *
 * Wired into `npm run predeploy:static` alongside the other `check:*-drift` guards.
 *
 * Run manually:  `npx tsx scripts/_check-ticket-direction-path-drift.ts`
 */
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";
import { pgClient } from "./_bootstrap";

const REPO_ROOT = resolve(__dirname, "..");
const SDK_PATH = resolve(REPO_ROOT, "src/lib/ticket-directions.ts");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase/migrations");
const ENUM_NAME = "ticket_direction_path";

function fail(msg: string): never {
  console.error(`\n❌ check-ticket-direction-path-drift — ${msg}\n`);
  process.exit(1);
}

/**
 * Extract the quoted union members from
 *   `export type TicketDirectionPath = "playbook" | "journey" | "workflow" | ...;`
 * The union is a single-line declaration by convention (line 14 of the SDK today). Read the
 * source text so this check needs no runtime import of the SDK — that keeps drift detection
 * insulated from an unrelated compile error in the SDK breaking the guard.
 */
function extractTsUnionMembers(src: string): string[] {
  const m = /export\s+type\s+TicketDirectionPath\s*=\s*([^;]+);/.exec(src);
  if (!m) {
    fail(
      `could not locate the TicketDirectionPath union in ${SDK_PATH}. ` +
        `Expected \`export type TicketDirectionPath = "..." | "..." | ...;\`. Was the declaration ` +
        `renamed or reshaped?`,
    );
  }
  const body = m[1];
  const out: string[] = [];
  const q = /"([a-z0-9_-]+)"/gi;
  let e: RegExpExecArray | null;
  while ((e = q.exec(body)) !== null) out.push(e[1]);
  if (out.length === 0) {
    fail(
      `parsed the TicketDirectionPath union but found zero quoted members — the declaration shape ` +
        `has drifted from the expected \`"x" | "y" | "z"\` form.`,
    );
  }
  return out;
}

/**
 * Read every `ALTER TYPE (public.)?ticket_direction_path ADD VALUE (IF NOT EXISTS)? '<label>'`
 * statement from every SQL file in `supabase/migrations/`. Line comments (`-- ...`) are stripped
 * before matching so a commented-out ALTER doesn't count.
 *
 * Why this exists: the live DB enum only reflects migrations that have already applied. A
 * migration co-committed with a TS-union change (the exact shape of the Phase-1 fix — the
 * `'workflow'` migration ships in the same PR as the guard) is still on disk-but-not-yet-applied
 * when predeploy runs. Unioning committed additions with the live enum gives the guard the
 * correct oracle: "the enum labels that will exist after this PR merges and applyMergedMigrations
 * runs". That preserves drift detection (a TS value with NEITHER a live enum entry NOR a
 * committed migration still fails) without perma-red on every co-shipped path.
 *
 * The initial `CREATE TYPE ... AS ENUM (...)` values are NOT parsed here — they're always
 * present in the live enum once the bootstrap migration has applied, which is universally true
 * on any DB the check successfully connects to.
 */
function readCommittedAddValueLabels(): Set<string> {
  const out = new Set<string>();
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
  } catch {
    return out; // no migrations dir → nothing to union
  }
  const re = new RegExp(
    `ALTER\\s+TYPE\\s+(?:public\\.)?${ENUM_NAME}\\s+ADD\\s+VALUE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'([a-z0-9_-]+)'`,
    "gi",
  );
  for (const f of files) {
    let src: string;
    try {
      src = readFileSync(resolve(MIGRATIONS_DIR, f), "utf8");
    } catch {
      continue;
    }
    // Strip `-- ...` line comments so a commented-out ALTER doesn't count.
    const stripped = src
      .split("\n")
      .map((line) => {
        const i = line.indexOf("--");
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join("\n");
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(stripped)) !== null) out.add(m[1]);
  }
  return out;
}

/**
 * Read the live enum labels for `public.ticket_direction_path` via pg_enum join pg_type.
 * Returns null when the DB is unreachable (missing pooler creds / network) so the caller can
 * SKIP with a clear message rather than fail the deploy.
 */
async function readEnumLabels(): Promise<string[] | null> {
  let client;
  try {
    client = pgClient();
  } catch {
    return null;
  }
  try {
    await client.connect();
  } catch {
    return null;
  }
  try {
    const r = await client.query<{ label: string }>(
      `SELECT e.enumlabel AS label
         FROM pg_enum e
         JOIN pg_type t ON t.oid = e.enumtypid
         JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typname = $1
        ORDER BY e.enumsortorder`,
      [ENUM_NAME],
    );
    if (r.rows.length === 0) {
      fail(
        `public.${ENUM_NAME} exists in the TS union but returned zero enum labels from Postgres. ` +
          `Either the enum was dropped OR this run connected to a DB that never had it — investigate ` +
          `before flipping this to SKIP.`,
      );
    }
    return r.rows.map((row) => row.label);
  } finally {
    try {
      await client.end();
    } catch {
      // best-effort teardown
    }
  }
}

async function main(): Promise<void> {
  let src: string;
  try {
    src = readFileSync(SDK_PATH, "utf8");
  } catch (e) {
    fail(`could not read ${SDK_PATH}: ${(e as Error).message}`);
  }
  const tsMembers = extractTsUnionMembers(src);

  const enumLabels = await readEnumLabels();
  if (enumLabels === null) {
    console.log(
      `✓ check-ticket-direction-path-drift — SKIPPED (no DB connection; runs where the pooler is reachable).`,
    );
    return;
  }

  // Union live enum with committed-but-maybe-not-yet-applied ADD VALUE migrations so the guard's
  // oracle reflects post-merge DB state, not the racy pre-merge snapshot. See
  // `readCommittedAddValueLabels` for the reasoning.
  const committedAdds = readCommittedAddValueLabels();
  const liveSet = new Set(enumLabels);
  const effectiveSet = new Set<string>([...liveSet, ...committedAdds]);
  const tsSet = new Set(tsMembers);
  const errors: string[] = [];

  for (const m of tsMembers) {
    if (!effectiveSet.has(m)) {
      errors.push(
        `"${m}" is in the TicketDirectionPath TS union (${SDK_PATH}) but NOT in the public.${ENUM_NAME} ` +
          `Postgres enum AND no committed migration adds it. Add a migration ` +
          `\`ALTER TYPE public.${ENUM_NAME} ADD VALUE IF NOT EXISTS '${m}';\` ` +
          `(mirror supabase/migrations/20261213120000_ticket_direction_path_workflow.sql). Sol sessions ` +
          `that pick chosen_path='${m}' will hard-fail on the insert until the enum carries it.`,
      );
    }
  }
  for (const l of effectiveSet) {
    if (!tsSet.has(l)) {
      const source = liveSet.has(l)
        ? `is in the public.${ENUM_NAME} Postgres enum`
        : `is added by a committed \`ALTER TYPE ... ADD VALUE '${l}'\` migration under supabase/migrations/`;
      errors.push(
        `"${l}" ${source} but NOT in the TicketDirectionPath TS union (${SDK_PATH}). Either add "${l}" ` +
          `to the union (and any \`validatePlanForPath\` branch it needs) OR remove it — Postgres enums ` +
          `are add-only, so removing a live label is a rename-and-migrate rather than a bare DROP VALUE.`,
      );
    }
  }

  if (errors.length > 0) {
    for (const err of errors) console.error(`  • ${err}`);
    fail(
      `${errors.length} ticket_direction_path drift issue${errors.length === 1 ? "" : "s"} found — the ` +
        `TS union and the (live ∪ committed-migration) Postgres enum disagree. This is exactly the class ` +
        `Phase 1 fixed (three Sol sessions were killed by the 'workflow' drift between 2026-07-28 and ` +
        `2026-08-05); do not ship until both sides move together.`,
    );
  }

  const pendingCount = [...committedAdds].filter((v) => !liveSet.has(v)).length;
  const pendingNote = pendingCount > 0 ? ` (${pendingCount} pending migration ADD VALUE)` : "";
  console.log(
    `✓ check-ticket-direction-path-drift — TS union (${tsMembers.length}) and public.${ENUM_NAME} enum ` +
      `(${liveSet.size} live${pendingNote}) match.`,
  );
}

main().catch((e) => {
  console.error(
    "❌ check-ticket-direction-path-drift threw:",
    e instanceof Error ? (e.stack ?? e.message) : e,
  );
  process.exit(1);
});
