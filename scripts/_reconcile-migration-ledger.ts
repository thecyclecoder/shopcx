/**
 * One-time throwaway: reconcile supabase_migrations.schema_migrations against the
 * supabase/migrations/*.sql files on main, closing the 103-version ledger backlog that keeps the
 * migration-drift reconciler retrying merged-but-unrecorded migrations every tick.
 *
 * migration-drift-reconciler-idempotent-on-already-applied-objects spec Phase 2.
 *
 * The classifier fix (Phase 1) teaches the reconciler that a duplicate-object SQLSTATE means
 * already-applied, so the tile will heal over subsequent ticks — but the backlog will drip through
 * one file per poll and every attempt logs a Postgres error along the way. This script drains the
 * backlog in ONE pass. Phase 3 (this file) does the classification **at the statement level** —
 * see `splitSqlStatements` in src/lib/control-tower/migration-drift.ts — so a multi-statement
 * migration whose first statement throws duplicate-object doesn't leave the tail statements
 * silently unapplied (the whole-file duplicate shortcut the security review flagged). Each
 * statement runs in its own SAVEPOINT and is classified independently:
 *
 *   - statement succeeds                   → applied-fresh (did DDL work; savepoint released)
 *   - throws a duplicate-object SQLSTATE   → verified-already-present (savepoint rolled back;
 *                                             the specific object is in the live schema)
 *   - throws anything else                 → the file is broken. Roll back EVERYTHING the file
 *                                             touched (via the outer container savepoint) and
 *                                             record NOTHING for this version. This script must
 *                                             NEVER force-record a broken migration into the
 *                                             ledger — the ordinary reconciler will keep naming
 *                                             it until a human looks.
 *
 * Aggregate outcome (only when every statement was accounted for — no broken statements):
 *   - all fresh                            → recorded-genuinely-applied
 *   - all verified-already-present          → recorded-already-applied
 *   - mix of fresh + verified-already      → recorded-partially-applied (some statements did DDL
 *                                             work AND some were already there; the file is now
 *                                             fully present, safe to record)
 *
 * Dry-run by default (safe to run any time): prints the plan and per-version SAVEPOINT outcomes
 * without recording anything. Pass `--apply` to actually run the ledger inserts + the DDL commits
 * for the genuinely-unapplied set. The classification pass ALWAYS runs (that's the whole point —
 * we need to know which bucket each version falls into); only the INSERT + savepoint RELEASE side-
 * effect is gated on `--apply`.
 *
 * The classification uses `isDuplicateObjectError` from src/lib/control-tower/migration-drift.ts —
 * the exact same 6-SQLSTATE definition the additive auto-apply path (Phase 1) uses, so a version
 * this script leaves apply-failed is the same version the tile keeps red.
 *
 * Usage:
 *   npx tsx scripts/_reconcile-migration-ledger.ts             # dry-run — classification + summary
 *   npx tsx scripts/_reconcile-migration-ledger.ts --apply     # commit the reconcile
 *
 * Read the write-a-migration-apply-script recipe for the pooler/SQL invariants this follows.
 */
import { readFileSync, readdirSync } from "fs";
import { resolve, join } from "path";
import { poolerConnectionString } from "./_bootstrap";
import {
  extractMigrationVersion,
  isDuplicateObjectError,
  splitSqlStatements,
} from "../src/lib/control-tower/migration-drift";

const MIGRATIONS_DIR = resolve(__dirname, "../supabase/migrations");
const APPLY = process.argv.includes("--apply");

type Outcome =
  | "recorded-already-applied"
  | "recorded-genuinely-applied"
  | "recorded-partially-applied"
  | "skipped-broken";

interface PerVersionResult {
  version: string;
  file: string;
  outcome: Outcome;
  /** Populated for skipped-broken (the genuine error to hand to a human), and for the sqlstate we saw on duplicate-object (informational). */
  detail?: string;
  sqlstate?: string;
  /** Per-statement bucketing for the version's file (Phase 3 statement-level classifier). */
  statementCounts?: { total: number; freshApplied: number; alreadyPresent: number };
  /** 1-based index of the first statement that threw a genuine (non-duplicate-object) error. */
  brokenStatementIndex?: number;
}

function listLocalVersions(): Array<{ version: string; file: string; sql: string }> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const out: Array<{ version: string; file: string; sql: string }> = [];
  for (const file of files) {
    const version = extractMigrationVersion(file);
    if (version == null) continue; // off-format (e.g. `_PENDING_*.sql`) — skipped by the reconcile itself.
    out.push({ version, file, sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8") });
  }
  return out;
}

async function readAppliedVersions(c: import("pg").Client): Promise<Set<string>> {
  const { rows } = await c.query<{ version: string }>(
    `select version from supabase_migrations.schema_migrations`,
  );
  return new Set(rows.map((r) => r.version));
}

/**
 * Insert the version into `supabase_migrations.schema_migrations` with ON CONFLICT (version) DO
 * NOTHING. Each shape-attempt runs in its own SAVEPOINT so a failed statement doesn't abort the
 * outer transaction ("current transaction is aborted, commands ignored" — the whole point of the
 * savepoint isolation). Same permissive shape as `scripts/builder-worker.ts applyMigrationAndRecord`
 * — falls back to `(version, name)` then `(version)` if a NOT-NULL column is missing on the
 * target's Supabase schema revision.
 */
async function recordVersion(
  c: import("pg").Client,
  input: { version: string; file: string; sql: string },
): Promise<void> {
  const nameWithoutExt = input.file.replace(/\.sql$/, "");
  const attempts: Array<{ sql: string; params: unknown[] }> = [
    {
      sql: `insert into supabase_migrations.schema_migrations (version, name, statements)
            values ($1, $2, array[$3]::text[])
            on conflict (version) do nothing`,
      params: [input.version, nameWithoutExt, input.sql],
    },
    {
      sql: `insert into supabase_migrations.schema_migrations (version, name)
            values ($1, $2)
            on conflict (version) do nothing`,
      params: [input.version, nameWithoutExt],
    },
    {
      sql: `insert into supabase_migrations.schema_migrations (version)
            values ($1)
            on conflict (version) do nothing`,
      params: [input.version],
    },
  ];
  const savepointName = `rec_${input.version}`;
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    await c.query(`SAVEPOINT ${savepointName}`);
    try {
      await c.query(a.sql, a.params);
      await c.query(`RELEASE SAVEPOINT ${savepointName}`);
      return;
    } catch (err) {
      await c.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      await c.query(`RELEASE SAVEPOINT ${savepointName}`);
      if (i === attempts.length - 1) throw err;
    }
  }
}

/**
 * Statement-level classification (spec Phase 3 — fixes the whole-file duplicate shortcut the
 * security review flagged). Splits the file at top-level statement boundaries via
 * `splitSqlStatements` (dollar-quote / string / comment aware) and attempts each statement in its
 * OWN nested savepoint:
 *
 *  - statement succeeds                  → applied-fresh (that statement did DDL work)
 *  - throws a duplicate-object SQLSTATE  → verified-already-present (rolled back; the specific
 *                                          object is in the live schema — safe to skip THIS
 *                                          statement without hiding a tail statement)
 *  - throws anything else                → the file is broken. Bail immediately with
 *                                          outcome='skipped-broken', naming the offending
 *                                          statement index — the caller records NOTHING so a
 *                                          partially-applied migration is never falsely stamped
 *                                          as reconciled.
 *
 * Aggregate outcome for the file:
 *  - any statement broken             → 'skipped-broken' (do not record the version)
 *  - all statements applied-fresh     → 'recorded-genuinely-applied'
 *  - all statements verified-already  → 'recorded-already-applied'
 *  - a mix of fresh + verified        → 'recorded-partially-applied' (some DDL work happened AND
 *                                       some objects were already there — every statement is
 *                                       accounted for; the file is now fully present)
 *
 * The outer savepoint stays as a container so we can efficiently roll back everything the file did
 * in dry-run mode. On --apply we RELEASE the container so any applied-fresh DDL commits with the
 * outer transaction; on dry-run we ROLLBACK TO the container so nothing sticks.
 */
async function classifyOne(
  c: import("pg").Client,
  item: { version: string; file: string; sql: string },
): Promise<{
  outcome: Outcome;
  detail?: string;
  sqlstate?: string;
  statementCounts: { total: number; freshApplied: number; alreadyPresent: number };
  brokenStatementIndex?: number;
}> {
  const containerSp = `mig_${item.version}`;
  const statements = splitSqlStatements(item.sql);
  const counts = { total: statements.length, freshApplied: 0, alreadyPresent: 0 };
  // An empty file (comments-only, e.g. a scratchpad migration): treat as trivially already-present
  // — nothing to run, ledger record is safe. This mirrors Postgres semantics for an empty script.
  if (statements.length === 0) {
    return { outcome: "recorded-already-applied", statementCounts: counts };
  }

  await c.query(`SAVEPOINT ${containerSp}`);
  try {
    for (let idx = 0; idx < statements.length; idx++) {
      const stmt = statements[idx];
      const stmtSp = `mig_${item.version}_s${idx}`;
      await c.query(`SAVEPOINT ${stmtSp}`);
      try {
        await c.query(stmt);
        await c.query(`RELEASE SAVEPOINT ${stmtSp}`);
        counts.freshApplied++;
      } catch (err) {
        await c.query(`ROLLBACK TO SAVEPOINT ${stmtSp}`);
        await c.query(`RELEASE SAVEPOINT ${stmtSp}`);
        if (isDuplicateObjectError(err)) {
          counts.alreadyPresent++;
          continue;
        }
        // Genuine error — drop the whole file. Roll back everything the file did (fresh DDL from
        // earlier statements never commits) and record NOTHING for this version.
        const detail = err instanceof Error ? err.message : String(err);
        const sqlstate = (err as { code?: string })?.code;
        await c.query(`ROLLBACK TO SAVEPOINT ${containerSp}`);
        await c.query(`RELEASE SAVEPOINT ${containerSp}`);
        return {
          outcome: "skipped-broken",
          detail,
          sqlstate,
          statementCounts: counts,
          brokenStatementIndex: idx + 1,
        };
      }
    }

    // Every statement accounted for. Commit (on --apply) or roll back (on dry-run) the container.
    if (APPLY) {
      await c.query(`RELEASE SAVEPOINT ${containerSp}`);
    } else {
      await c.query(`ROLLBACK TO SAVEPOINT ${containerSp}`);
      await c.query(`RELEASE SAVEPOINT ${containerSp}`);
    }
    const outcome: Outcome =
      counts.freshApplied === 0
        ? "recorded-already-applied"
        : counts.alreadyPresent === 0
          ? "recorded-genuinely-applied"
          : "recorded-partially-applied";
    return { outcome, statementCounts: counts };
  } catch (unexpected) {
    // Something outside a per-statement savepoint failed (a SAVEPOINT/RELEASE misuse). Best-effort
    // roll the container back so the outer tx isn't poisoned; surface as skipped-broken.
    try {
      await c.query(`ROLLBACK TO SAVEPOINT ${containerSp}`);
      await c.query(`RELEASE SAVEPOINT ${containerSp}`);
    } catch {}
    const detail = unexpected instanceof Error ? unexpected.message : String(unexpected);
    return {
      outcome: "skipped-broken",
      detail: `container-savepoint failure: ${detail}`,
      statementCounts: counts,
    };
  }
}

async function main(): Promise<void> {
  const modeBanner = APPLY
    ? "MODE: --apply (will record versions and commit genuinely-applied DDL)"
    : "MODE: dry-run (no writes; pass --apply to commit)";
  console.log(`[reconcile-migration-ledger] ${modeBanner}`);
  console.log(`[reconcile-migration-ledger] migrations dir: ${MIGRATIONS_DIR}`);

  const local = listLocalVersions();
  console.log(`[reconcile-migration-ledger] local versions on main: ${local.length}`);

  const { Client } = await import("pg");
  const c = new Client({ connectionString: poolerConnectionString() });
  await c.connect();
  const perVersion: PerVersionResult[] = [];
  try {
    const applied = await readAppliedVersions(c);
    console.log(`[reconcile-migration-ledger] versions recorded in schema_migrations: ${applied.size}`);

    const unrecorded = local.filter((m) => !applied.has(m.version));
    console.log(
      `[reconcile-migration-ledger] merged-but-unrecorded to reconcile: ${unrecorded.length}`,
    );
    if (unrecorded.length === 0) {
      console.log("[reconcile-migration-ledger] nothing to do — ledger is up to date.");
      return;
    }

    // Everything runs inside ONE transaction so the ledger inserts + genuinely-applied DDL all
    // commit or all roll back together. Per-version failures are isolated by savepoints so a bad
    // file never poisons the outer transaction.
    await c.query("BEGIN");
    try {
      for (const item of unrecorded) {
        const res = await classifyOne(c, item);
        perVersion.push({
          version: item.version,
          file: item.file,
          outcome: res.outcome,
          detail: res.detail,
          sqlstate: res.sqlstate,
          statementCounts: res.statementCounts,
          brokenStatementIndex: res.brokenStatementIndex,
        });
        // Only record when EVERY statement in the file was accounted for (fresh + already-present).
        // A skipped-broken file has ≥1 statement that threw a non-duplicate-object error → record
        // NOTHING so the ordinary reconciler keeps naming it and a human looks. Phase 3 fix — the
        // whole-file duplicate shortcut is replaced by statement-level classification.
        if (
          APPLY &&
          (res.outcome === "recorded-genuinely-applied" ||
            res.outcome === "recorded-already-applied" ||
            res.outcome === "recorded-partially-applied")
        ) {
          await recordVersion(c, item);
        }
      }
      if (APPLY) {
        await c.query("COMMIT");
      } else {
        await c.query("ROLLBACK");
      }
    } catch (txErr) {
      await c.query("ROLLBACK").catch(() => {});
      throw txErr;
    }
  } finally {
    await c.end();
  }

  // Summary — grouped by outcome, then per-version lines.
  const grouped: Record<Outcome, PerVersionResult[]> = {
    "recorded-already-applied": [],
    "recorded-genuinely-applied": [],
    "recorded-partially-applied": [],
    "skipped-broken": [],
  };
  for (const r of perVersion) grouped[r.outcome].push(r);

  console.log("");
  console.log("[reconcile-migration-ledger] summary:");
  console.log(
    `  recorded-as-already-applied  (every statement was a duplicate-object hit)          : ${grouped["recorded-already-applied"].length}`,
  );
  console.log(
    `  recorded-as-genuinely-applied (every statement ran clean)                          : ${grouped["recorded-genuinely-applied"].length}`,
  );
  console.log(
    `  recorded-as-partially-applied (mix of fresh + already-present — file now complete) : ${grouped["recorded-partially-applied"].length}`,
  );
  console.log(
    `  skipped-broken (≥1 statement threw a non-duplicate-object error — NOT recorded)    : ${grouped["skipped-broken"].length}`,
  );

  if (grouped["skipped-broken"].length > 0) {
    console.log("");
    console.log("[reconcile-migration-ledger] skipped-broken details:");
    for (const r of grouped["skipped-broken"]) {
      const stmtNote = r.brokenStatementIndex
        ? ` at statement ${r.brokenStatementIndex}/${r.statementCounts?.total ?? "?"}`
        : "";
      console.log(
        `  ✗ ${r.version} ${r.file}${r.sqlstate ? ` [${r.sqlstate}]` : ""}${stmtNote} — ${r.detail ?? "unknown"}`,
      );
    }
  }
  if (grouped["recorded-partially-applied"].length > 0) {
    console.log("");
    console.log("[reconcile-migration-ledger] recorded-partially-applied (some statements were fresh, others were duplicates):");
    for (const r of grouped["recorded-partially-applied"]) {
      const c = r.statementCounts;
      console.log(
        `  ↺ ${r.version} ${r.file} — ${c?.freshApplied ?? "?"} fresh + ${c?.alreadyPresent ?? "?"} already-present of ${c?.total ?? "?"} statements`,
      );
    }
  }

  if (!APPLY) {
    console.log("");
    console.log(
      "[reconcile-migration-ledger] dry-run complete. Re-run with --apply to commit the reconcile.",
    );
  } else {
    console.log("");
    console.log(
      `[reconcile-migration-ledger] --apply complete. Re-run the migration-drift reconciler on the box to confirm the merged-but-unapplied count dropped toward 0.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
