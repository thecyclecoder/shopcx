/**
 * One-time backfill for identity-gmail-canonicalization-and-dot-insensitive-matching (Phase 2).
 *
 * Populates `customers.email_canonical` for every existing row where it's still NULL.
 * The Phase-2 migration already runs an idempotent `UPDATE ... WHERE email_canonical IS NULL`
 * inline, so on the standard auto-apply path this script is a no-op safety net that
 * simply confirms zero remaining rows. It exists to satisfy the CLAUDE.md
 * ship-time-backfill convention: an idempotent `scripts/_backfill-*.ts` auto-ledgered to
 * `public.data_op_runs` via `detectAndEscalateShipTimeBackfills` and drained on the box by
 * `executeShipTimeBackfillsForSpec`, so an un-run backfill is never dead code — it
 * escalates to the CEO inbox if it stalls in `pending`.
 *
 * Why keep it even though the migration UPDATE covers the common case:
 *   - If a workspace ever grows past the point where an inline table-wide UPDATE is
 *     comfortable, chunk-and-resume via this script instead.
 *   - If the migration ran on a stale replica and left stragglers, this closes the gap.
 *   - The BEFORE INSERT/UPDATE trigger keeps NEW rows correct; this covers the tail.
 *
 * Scoped to CANONICAL only — never rewrites the stored `email`. Uses a
 * compare-and-set predicate (`email_canonical IS NULL AND email IS NOT NULL`) so a
 * concurrent write can't be clobbered. Chunked by (workspace_id, id) cursor.
 *
 * Dry-run by default. Pass `--apply` to write.
 *   npx tsx scripts/_backfill-customers-email-canonical.ts           # dry-run
 *   npx tsx scripts/_backfill-customers-email-canonical.ts --apply   # write
 */
import { createAdminClient } from "./_bootstrap";
import { canonicalizeEmail } from "@/lib/email-utils";

const CHUNK = 1000;

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  console.log(`customers_email_canonical_backfill — ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  scope: email_canonical IS NULL AND email IS NOT NULL (all workspaces)`);
  console.log(`  chunk: ${CHUNK}`);

  let totalCandidates = 0;
  let totalUpdated = 0;
  let totalSkipped = 0; // rows whose canonicalizer returned "" — leave email_canonical NULL
  let cursor: string | null = null;

  // Cursor-paginate by id so a partial run resumes cleanly on the next invocation.
  // We select id + email only — nothing else is needed to compute the canonical.
  // Idempotent by predicate: every write filters on `email_canonical IS NULL`, so
  // a re-run finds only the still-null tail.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let query = admin
      .from("customers")
      .select("id, email")
      .is("email_canonical", null)
      .not("email", "is", null)
      .order("id", { ascending: true })
      .limit(CHUNK);
    if (cursor) query = query.gt("id", cursor);

    const { data, error } = await query;
    if (error) {
      console.error("read_failed", error.message);
      process.exit(1);
    }
    const rows = (data ?? []) as Array<{ id: string; email: string }>;
    if (rows.length === 0) break;
    totalCandidates += rows.length;

    for (const row of rows) {
      const canonical = canonicalizeEmail(row.email);
      if (!canonical) {
        // Empty canonical means the email was itself empty/whitespace — nothing safe
        // to write. Leave email_canonical NULL and count it. Should be ~0 given the
        // `email IS NOT NULL` filter, but the helper's contract is total so we handle it.
        totalSkipped += 1;
        continue;
      }
      if (!apply) continue;
      // Compare-and-set: only flip a row whose email_canonical is STILL null, so a
      // concurrent write (e.g. a fresh insert firing the trigger) can't be overwritten.
      const { data: updated, error: updErr } = await admin
        .from("customers")
        .update({ email_canonical: canonical })
        .eq("id", row.id)
        .is("email_canonical", null)
        .select("id");
      if (updErr) {
        console.error(`update_failed id=${row.id}`, updErr.message);
        process.exit(1);
      }
      if ((updated ?? []).length > 0) totalUpdated += 1;
    }

    cursor = rows[rows.length - 1].id;
    console.log(
      `  cursor=${cursor.slice(0, 8)}  candidates=${totalCandidates}  updated=${totalUpdated}  skipped=${totalSkipped}`,
    );
    if (rows.length < CHUNK) break;
  }

  console.log("");
  console.log(`  total candidates: ${totalCandidates}`);
  console.log(`  total updated:    ${totalUpdated}`);
  console.log(`  total skipped:    ${totalSkipped}  (email canonicalized to empty — left NULL)`);
  if (!apply) {
    console.log("\n(dry-run) — rerun with --apply to populate email_canonical.");
  }
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
