/**
 * Static-analysis check: no two migration files under supabase/migrations/*.sql may share the
 * same 14-digit YYYYMMDDNNNNNN version prefix.
 *
 * unique-migration-version-guard-and-collision-audit Phase 2. The AUTHORING rail that pairs with
 * the RUNTIME rail (`detectDuplicateLocalVersions` in src/lib/control-tower/migration-drift.ts,
 * added by the sibling migration-drift-detect-duplicate-14-digit-version-collisions build): the
 * runtime rail flips the migration-drift tile red when a collision lands in prod, this rail
 * binds the AUTHOR at PR-open time so a collision never gets checked in in the first place —
 * same-shape gate as `_check-no-hard-destructive-migrations.ts`.
 *
 * Rule:
 *   Every 14-digit prefix under supabase/migrations/*.sql must appear on EXACTLY ONE file. Two
 *   files sharing the same prefix (`20260605120000_ad_segment_source.sql` and
 *   `20260605120000_loyalty_backfill_flag.sql`) both try to land under the same
 *   `supabase_migrations.schema_migrations.version` key at apply time — only one can be
 *   recorded, the other is silently skipped and its DDL is invisibly missing from prod (exact
 *   class that caused the media-buyer excluded-all-customers-audience column to sit unlanded
 *   for weeks, repeatedly firing the vercel:03e0d0666e56968c weekly-cron signature).
 *
 * Fix for a violation:
 *   Bump the trailing NNNNNN counter on ONE of the colliding siblings to the next unused value:
 *     git mv supabase/migrations/20260605120000_loyalty_backfill_flag.sql \
 *            supabase/migrations/20260605120001_loyalty_backfill_flag.sql
 *   The additive auto-apply loop in [[../src/lib/control-tower/migration-drift.ts]]
 *   `applyMergedMigrations` will detect the renamed file as merged-but-unapplied on the next
 *   Control Tower tick and idempotently re-apply / mark already-applied.
 *
 *   For the audit trail on a pre-existing rename, ship a paired
 *   `supabase/migrations/YYYYMMDDNNNNNN_backfill_renamed_collision_versions.sql` that inserts
 *   the new version into `supabase_migrations.schema_migrations` with `on conflict do nothing`
 *   so the reconciler doesn't spuriously flag it as merged-but-unapplied.
 *
 * Wired into `npm run check:duplicate-migration-versions` + chained into `predeploy` alongside
 * the sibling `_check-no-hard-destructive-migrations.ts`.
 *
 * Read-only; never mutates state.
 */
import { readdirSync } from "fs";
import { join } from "path";

const REPO_ROOT = join(__dirname, "..");
const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

/** The 14-digit prefix of a filename, or null when the file doesn't follow the convention. */
export function extractPrefix(filename: string): string | null {
  const m = filename.match(/^(\d{14})_/);
  return m ? m[1] : null;
}

/** A collision cluster — one version + the files sharing it. */
export interface Cluster {
  version: string;
  files: string[];
}

/**
 * Group *.sql files in `migrationsDir` by 14-digit prefix and return every cluster of size > 1.
 * Files that don't follow the timestamped convention (e.g. the scratch `_PENDING_*.sql` pattern
 * the write-migration recipe uses) are skipped — they have no reliable prefix to collide on.
 */
export function detectDuplicateVersions(migrationsDir: string): Cluster[] {
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  const g = new Map<string, string[]>();
  for (const f of files) {
    const prefix = extractPrefix(f);
    if (prefix == null) continue;
    const list = g.get(prefix) ?? [];
    list.push(f);
    g.set(prefix, list);
  }
  return [...g.entries()]
    .filter(([, fs]) => fs.length > 1)
    .map(([version, files]) => ({ version, files }))
    .sort((a, b) => a.version.localeCompare(b.version));
}

function main(): void {
  const clusters = detectDuplicateVersions(MIGRATIONS_DIR);
  if (clusters.length) {
    console.error(
      `\n❌ check-duplicate-migration-versions — ${clusters.length} colliding 14-digit prefix${clusters.length === 1 ? "" : "es"}:`,
    );
    for (const c of clusters) {
      console.error(`  • ${c.version}  ${c.files.join(", ")}`);
    }
    console.error(
      `\nTwo migrations sharing the same 14-digit YYYYMMDDNNNNNN prefix collide under the same\n` +
        `supabase_migrations.schema_migrations.version key — only one is recorded on apply, the\n` +
        `other's DDL is silently skipped and invisibly missing from prod.\n\n` +
        `Fix: bump the trailing NNNNNN counter on ONE of the colliding siblings to the next\n` +
        `unused value:\n` +
        `  git mv supabase/migrations/20260605120000_loyalty_backfill_flag.sql \\\n` +
        `         supabase/migrations/20260605120001_loyalty_backfill_flag.sql\n\n` +
        `Ship a paired supabase/migrations/YYYYMMDDNNNNNN_backfill_renamed_collision_versions.sql\n` +
        `that inserts the new version into supabase_migrations.schema_migrations with ON CONFLICT\n` +
        `DO NOTHING so the reconciler doesn't spuriously flag it as merged-but-unapplied.\n`,
    );
    process.exit(1);
  }
  console.log(
    `✓ check-duplicate-migration-versions — every migration file has a unique 14-digit prefix.`,
  );
}

if (require.main === module) main();
