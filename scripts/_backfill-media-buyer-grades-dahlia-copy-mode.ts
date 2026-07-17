/**
 * One-time backfill for dahlia-cold-graded-inline-link-ctr-leading-signal (Phase 2).
 *
 * The Phase-2 migration adds media_buyer_action_grades.dahlia_copy_mode ('author'|'deterministic'|null).
 * Going forward the grader stamps it at grade time (src/lib/media-buyer/grader.ts →
 * resolveDahliaCopyMode). This script walks EXISTING grade rows whose dahlia_copy_mode is NULL
 * and stamps the mode by joining source_meta_ad_id → ad_publish_jobs.meta_ad_id →
 * ad_publish_jobs.campaign_id → ad_campaigns.author_self_score (non-null → 'author'; null →
 * 'deterministic'). A grade row whose source_meta_ad_id has no ad_publish_jobs match stays NULL
 * (legacy/off-platform ad — per-mode readers exclude it, which is the correct signal).
 *
 * Auto-ledgered on merge by src/lib/ship-time-backfill-detector.ts detectAndEscalateShipTimeBackfills
 * (writes a `pending` row to public.data_op_runs and escalates any un-run row to the CEO inbox); the
 * box worker's ship-time backfill executor runs it and flips the row to `ran`/`failed` on completion
 * (docs/brain/tables/data_op_runs.md, docs/brain/libraries/ship-time-backfill-detector.md).
 *
 * Idempotent (compare-and-set): only writes rows where dahlia_copy_mode IS NULL at update time, and
 * asserts one row per update via .select("id") so a concurrent grader can't get clobbered.
 *
 *   npx tsx scripts/_backfill-media-buyer-grades-dahlia-copy-mode.ts            # dry-run
 *   npx tsx scripts/_backfill-media-buyer-grades-dahlia-copy-mode.ts --apply    # write
 */
import { createAdminClient } from "./_bootstrap";

interface GradeRow {
  id: string;
  workspace_id: string;
  source_meta_ad_id: string | null;
  dahlia_copy_mode: string | null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const admin = createAdminClient();

  const { data: gradesRaw, error: readErr } = await admin
    .from("media_buyer_action_grades")
    .select("id, workspace_id, source_meta_ad_id, dahlia_copy_mode")
    .is("dahlia_copy_mode", null)
    .not("source_meta_ad_id", "is", null);
  if (readErr) {
    console.error("read_failed", readErr.message);
    process.exit(1);
  }
  const grades = (gradesRaw ?? []) as GradeRow[];

  console.log(`media_buyer_grades_dahlia_copy_mode_backfill — ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  scope:     dahlia_copy_mode IS NULL AND source_meta_ad_id IS NOT NULL`);
  console.log(`  found:     ${grades.length} grade row(s) to consider`);

  if (!grades.length) {
    console.log("nothing to backfill.");
    return;
  }

  // Look up author_self_score presence per (workspace, meta_ad_id) — one join per distinct key.
  const byKey = new Map<string, GradeRow[]>();
  for (const g of grades) {
    const key = `${g.workspace_id}|${g.source_meta_ad_id}`;
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = [];
      byKey.set(key, bucket);
    }
    bucket.push(g);
  }
  console.log(`  distinct:  ${byKey.size} (workspace, meta_ad_id) key(s)`);

  let stampedAuthor = 0;
  let stampedDeterministic = 0;
  let unresolved = 0;
  let updated = 0;

  for (const [key, rows] of byKey.entries()) {
    const [workspaceId, metaAdId] = key.split("|");
    const { data: pubRaw } = await admin
      .from("ad_publish_jobs")
      .select("campaign_id, ad_campaigns(author_self_score)")
      .eq("workspace_id", workspaceId)
      .eq("meta_ad_id", metaAdId)
      .limit(1);
    const pub = ((pubRaw ?? [])[0] || null) as
      | { campaign_id: string | null; ad_campaigns: { author_self_score: unknown } | Array<{ author_self_score: unknown }> | null }
      | null;
    let mode: "author" | "deterministic" | null = null;
    if (pub) {
      const rel = pub.ad_campaigns;
      const campaign = Array.isArray(rel) ? rel[0] ?? null : rel ?? null;
      if (campaign) mode = campaign.author_self_score == null ? "deterministic" : "author";
    }
    if (!mode) {
      unresolved += rows.length;
      continue;
    }
    if (mode === "author") stampedAuthor += rows.length;
    else stampedDeterministic += rows.length;

    if (!apply) continue;
    const ids = rows.map((r) => r.id);
    const { data: written, error: updErr } = await admin
      .from("media_buyer_action_grades")
      .update({ dahlia_copy_mode: mode })
      .in("id", ids)
      .eq("workspace_id", workspaceId)
      .is("dahlia_copy_mode", null)
      .select("id");
    if (updErr) {
      console.error(`update_failed key=${key}`, updErr.message);
      continue;
    }
    updated += ((written ?? []) as Array<{ id: string }>).length;
  }

  console.log(`  author:        ${stampedAuthor}`);
  console.log(`  deterministic: ${stampedDeterministic}`);
  console.log(`  unresolved:    ${unresolved} (legacy/off-platform — stay NULL)`);
  if (apply) {
    console.log(`  updated:       ${updated} grade row(s) stamped`);
  } else {
    console.log("\n(dry-run) — rerun with --apply to stamp the resolved rows.");
  }
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
