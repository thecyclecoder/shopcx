/**
 * specs-status-override-only one-off cleanup — set `specs.status = NULL` for every spec whose STORED status
 * is a DERIVED state (planned / in_progress / shipped). Those are purely derivable from the phase rollup and
 * must NOT live on the override-only column (the noop-pipeline-test-4 `planned` bug). True overrides
 * (in_review / deferred / folded) are left intact.
 *
 * Goes through the sanctioned SDK writer `setSpecStatus(ws, slug, null, actor)` — no raw `.from('specs')`
 * (pm-sdk-compliance). Dry-run by default; pass `--apply` to write.
 *
 *   npx tsx scripts/cleanup-derived-spec-status.ts          # dry-run
 *   npx tsx scripts/cleanup-derived-spec-status.ts --apply  # write
 */
import { createAdminClient } from "./_bootstrap";
import { setSpecStatus } from "../src/lib/specs-table";

const DERIVED = new Set(["planned", "in_progress", "shipped"]);
const APPLY = process.argv.includes("--apply");

async function main() {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("specs")
    .select("workspace_id, slug, status");
  if (error) throw error;
  const rows = (data ?? []) as { workspace_id: string; slug: string; status: string | null }[];
  const targets = rows.filter((r) => r.status && DERIVED.has(r.status));
  console.log(`Specs with a DERIVED stored status: ${targets.length}`);
  for (const t of targets) console.log(`  ${t.slug}  status=${t.status}  ws=${t.workspace_id}`);
  if (!targets.length) { console.log("Nothing to clean."); return; }
  if (!APPLY) { console.log("\nDRY-RUN — pass --apply to clear these to NULL."); return; }
  let cleaned = 0;
  for (const t of targets) {
    await setSpecStatus(t.workspace_id, t.slug, null, "cleanup:specs-status-override-only");
    cleaned++;
    console.log(`  ✓ cleared ${t.slug} → NULL`);
  }
  console.log(`\nCleaned ${cleaned} spec(s) to NULL (status now purely derived).`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
