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
 * backlog in ONE pass: for each merged-but-unrecorded version it attempts the DDL inside a
 * SAVEPOINT, and:
 *
 *   - success                              → the migration was GENUINELY unapplied. The savepoint is
 *                                            released (DDL committed) and the version is recorded.
 *   - throws a duplicate-object SQLSTATE   → the object already exists. The savepoint is rolled
 *                                            back (no DDL was needed) and the version is recorded
 *                                            as already-applied so the reconciler clears the tile.
 *   - throws anything else (syntax,        → the migration is genuinely broken. The savepoint is
 *     undefined_table, undefined_column…)   rolled back, the error is logged, and the version is
 *                                            LEFT UNRECORDED for a human to look at — this script
 *                                            must NEVER force-record a broken migration into the
 *                                            ledger.
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
} from "../src/lib/control-tower/migration-drift";

const MIGRATIONS_DIR = resolve(__dirname, "../supabase/migrations");
const APPLY = process.argv.includes("--apply");

type Outcome = "recorded-already-applied" | "recorded-genuinely-applied" | "skipped-broken";

interface PerVersionResult {
  version: string;
  file: string;
  outcome: Outcome;
  /** Populated for skipped-broken (the genuine error to hand to a human), and for the sqlstate we saw on duplicate-object (informational). */
  detail?: string;
  sqlstate?: string;
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
 * Attempt the DDL inside a SAVEPOINT so a duplicate-object failure (or any failure) can be rolled
 * back cleanly WITHOUT losing the outer transaction — the outer transaction owns the ledger insert
 * batch and must survive a bad file in the middle of the run.
 *
 * Postgres semantics used here: when a statement inside a SAVEPOINT throws, the transaction goes
 * into a failed state; `ROLLBACK TO SAVEPOINT` returns it to the pre-savepoint state (both undoing
 * the failed DDL AND clearing the failed status) so subsequent statements can run normally.
 */
async function classifyOne(
  c: import("pg").Client,
  item: { version: string; file: string; sql: string },
): Promise<{ outcome: Outcome; detail?: string; sqlstate?: string }> {
  const savepointName = `mig_${item.version}`;
  await c.query(`SAVEPOINT ${savepointName}`);
  try {
    await c.query(item.sql);
    // Genuinely unapplied — the DDL ran clean. On --apply we RELEASE the savepoint so the DDL
    // commits with the outer transaction; on dry-run we ROLLBACK so nothing was actually applied.
    if (APPLY) {
      await c.query(`RELEASE SAVEPOINT ${savepointName}`);
    } else {
      await c.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      await c.query(`RELEASE SAVEPOINT ${savepointName}`);
    }
    return { outcome: "recorded-genuinely-applied" };
  } catch (err) {
    // Any throw fails the transaction — rollback the savepoint before doing anything else.
    await c.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
    await c.query(`RELEASE SAVEPOINT ${savepointName}`);
    if (isDuplicateObjectError(err)) {
      const sqlstate = (err as { code?: string }).code;
      return { outcome: "recorded-already-applied", sqlstate };
    }
    const detail = err instanceof Error ? err.message : String(err);
    const sqlstate = (err as { code?: string })?.code;
    return { outcome: "skipped-broken", detail, sqlstate };
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
        });
        // Only record when the version is either genuinely-applied or already-applied. Broken
        // migrations stay unrecorded so a human sees them (the drift tile continues to name them
        // via the ordinary reconciler — this script must never force-record a broken migration).
        if (
          APPLY &&
          (res.outcome === "recorded-genuinely-applied" ||
            res.outcome === "recorded-already-applied")
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
    "skipped-broken": [],
  };
  for (const r of perVersion) grouped[r.outcome].push(r);

  console.log("");
  console.log("[reconcile-migration-ledger] summary:");
  console.log(
    `  recorded-as-already-applied (duplicate-object SQLSTATE)      : ${grouped["recorded-already-applied"].length}`,
  );
  console.log(
    `  recorded-as-genuinely-applied (DDL ran clean inside savepoint): ${grouped["recorded-genuinely-applied"].length}`,
  );
  console.log(
    `  skipped-broken (genuine error — leave for human review)       : ${grouped["skipped-broken"].length}`,
  );

  if (grouped["skipped-broken"].length > 0) {
    console.log("");
    console.log("[reconcile-migration-ledger] skipped-broken details:");
    for (const r of grouped["skipped-broken"]) {
      console.log(
        `  ✗ ${r.version} ${r.file}${r.sqlstate ? ` [${r.sqlstate}]` : ""} — ${r.detail ?? "unknown"}`,
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
