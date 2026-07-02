/**
 * One-off: flip mangled wikilink-shaped `specs.owner` values to the bare function slug.
 *
 * Background — two spec-author surfaces (src/lib/pre-merge-fix.ts + the request-a-fix inline route
 * src/app/api/roadmap/spec-test/request-fix/route.ts) shipped with `owner: "[[../functions/platform]]"`
 * instead of the bare `"platform"` slug the other ~170 rows carry. Vale rejects those rows with a
 * "Mangled Owner wikilink" reason, they stick in `in_review`, and Ada never dispositions them.
 *
 * Same-shape fix for every stuck row: strip the wrapper. The two code fixes ship in the same PR so
 * new rows land bare; this script is the one-time backfill for the rows already on disk.
 *
 * Dry-run by default; pass --apply to write. Idempotent: same script re-run touches 0 rows.
 *
 *   npx tsx scripts/_fix-mangled-spec-owners.ts          # dry-run — list the mangled rows
 *   npx tsx scripts/_fix-mangled-spec-owners.ts --apply  # flip them to the bare slug
 */
import { createAdminClient } from "./_bootstrap";

const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();

  const { data: rows, error } = await admin
    .from("specs")
    .select("workspace_id, slug, owner")
    .like("owner", "[[%");
  if (error) throw error;

  console.log(`\nMangled owners on public.specs: ${rows?.length ?? 0}`);
  for (const r of rows ?? []) {
    console.log(`  • ${r.slug}  owner=${JSON.stringify(r.owner)}`);
  }

  if (!APPLY) {
    console.log(`\n[dry-run] No writes. Re-run with --apply to normalize the above.\n`);
    return;
  }

  let flipped = 0;
  for (const r of rows ?? []) {
    const bare = String(r.owner).replace(/^\[\[\.\.\/functions\/([^\]]+)\]\]$/, "$1").trim();
    if (!bare || bare === r.owner) {
      console.log(`  · skip ${r.slug} (already bare or unparseable: ${JSON.stringify(r.owner)})`);
      continue;
    }
    const { error: uErr } = await admin
      .from("specs")
      .update({ owner: bare })
      .eq("workspace_id", r.workspace_id)
      .eq("slug", r.slug);
    if (uErr) {
      console.error(`  ! failed to update ${r.slug}: ${uErr.message}`);
    } else {
      flipped++;
      console.log(`  ✓ ${r.slug}  ${JSON.stringify(r.owner)} → ${JSON.stringify(bare)}`);
    }
  }

  console.log(`\nDONE — flipped ${flipped}/${rows?.length ?? 0} row(s).\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
