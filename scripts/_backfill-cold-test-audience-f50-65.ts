/**
 * One-shot backfill: re-align every live per-test cohort whose `adset_template.targeting`
 * still carries the pre-Phase-1 US 18-65 shape to the F50-65 converter shape.
 *
 * Phase 1 flipped [[../src/lib/media-buyer/provision-cohort]] `DEFAULT_TEST_TARGETING` so
 * FRESHLY-provisioned cohorts inherit F50-65, but every already-active per-test cohort
 * (Amazing Coffee, Creamer, Guru Focus, Zen Relax) still mints future per-test ad sets
 * against 18-65 until we re-align its stored template. This backfill does exactly that
 * on OUR row — the change lands the next time the Media Buyer's replenish/publish path
 * mints a per-test ad set (see [[../docs/brain/libraries/media-buyer-publish-gate]] +
 * [[../docs/brain/inngest/ad-tool]] `adToolPublishToMeta`). Meta is NEVER written here.
 *
 * Match rule: a row is UPDATED only if its `adset_template.targeting` DEEP-EQUALS the
 * exact pre-Phase-1 shape below. Any custom-targeted row (extra fields, different
 * age band, hand-edited genders, etc.) is SKIPPED — never overwritten. The write is a
 * compare-and-set: `.eq('adset_per_test', true).eq('is_active', true).contains(
 * 'adset_template', { targeting: OLD })` re-asserts the OLD shape is STILL present at
 * write-time, so a hand-edit between our read and our write can't be clobbered.
 *
 * Idempotent — re-running after a successful pass finds zero matches and exits clean.
 * Auto-ledgered by the post-merge [[../src/lib/ship-time-backfill-detector]] (the
 * `scripts/_backfill-*.ts` filename convention triggers the pending `data_op_runs`
 * row + CEO card) and drained on the box by
 * [[../src/lib/ship-time-backfill-executor]] `executeShipTimeBackfillsForSpec`.
 *
 * Dry-run by default (safe to run any time). Pass `--apply` to write. `APPLY=1` env
 * also accepted for parity with the sibling [[_backfill-cohort-adset-template.ts]].
 *
 *   npx tsx scripts/_backfill-cold-test-audience-f50-65.ts            # dry-run
 *   npx tsx scripts/_backfill-cold-test-audience-f50-65.ts --apply    # write
 *
 * Spec: docs/brain/specs/bianca-cold-test-audience-align-to-f50-65-converter Phase 2.
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";

// The exact pre-Phase-1 shape produced by the OLD DEFAULT_TEST_TARGETING literal. A row whose
// `adset_template.targeting` deep-equals this is the only kind we flip. Any custom shape
// (different age band, hand-edited genders, extra keys) is skipped by the SAME deep-equal check.
const OLD_TARGETING = {
  age_min: 18,
  age_max: 65,
  geo_locations: { countries: ["US"], location_types: ["home", "recent"] },
  targeting_automation: { advantage_audience: 1 },
} as const;

// The new F50-65 converter shape (mirrors src/lib/media-buyer/provision-cohort.ts
// DEFAULT_TEST_TARGETING after Phase 1). US women 50-65 per
// docs/brain/reference/meta-scaling-methodology.md § "Test audience held constant".
const NEW_TARGETING = {
  age_min: 50,
  age_max: 65,
  genders: [2],
  geo_locations: { countries: ["US"], location_types: ["home", "recent"] },
  targeting_automation: { advantage_audience: 1 },
} as const;

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const CHUNK = 500;

type CohortRow = {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  product_id: string | null;
  adset_per_test: boolean;
  is_active: boolean;
  adset_template: Record<string, unknown> | null;
};

/** Structural equality on plain JSON values (null / primitive / array / plain object). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

/** Pull the `.targeting` sub-object off an `adset_template` cell. Null-safe. */
function templateTargeting(t: CohortRow["adset_template"]): unknown {
  if (!t || typeof t !== "object") return null;
  return (t as Record<string, unknown>).targeting ?? null;
}

/** Deep-clone the template, swapping `.targeting` for NEW_TARGETING (never mutate the read row). */
function withNewTargeting(t: Record<string, unknown>): Record<string, unknown> {
  return { ...t, targeting: { ...NEW_TARGETING } };
}

(async () => {
  const admin = createAdminClient();

  console.log(`cold_test_audience_f50_65_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  OLD: ${JSON.stringify(OLD_TARGETING)}`);
  console.log(`  NEW: ${JSON.stringify(NEW_TARGETING)}\n`);

  // Cursor-paginated read of every ACTIVE per-test cohort. Filter is workspace-agnostic on purpose —
  // any workspace's per-test cohort that carries the OLD shape is a candidate. Ordered by `id` for
  // a stable cursor across chunks even if new rows land mid-scan.
  let cursor: string | null = null;
  let scanned = 0;
  let matched = 0; // deep-equals OLD in JS
  let skippedCustom = 0; // active per-test, but non-OLD targeting
  let updated = 0;
  let racedByCas = 0; // JS-matched OLD but the .contains() compare-and-set found the shape already flipped
  let wouldUpdate = 0; // JS-matched OLD in dry-run

  for (;;) {
    let q = admin
      .from("media_buyer_test_cohorts")
      .select("id, workspace_id, meta_ad_account_id, product_id, adset_per_test, is_active, adset_template")
      .eq("adset_per_test", true)
      .eq("is_active", true)
      .order("id", { ascending: true })
      .limit(CHUNK);
    if (cursor) q = q.gt("id", cursor);

    const { data, error } = await q;
    if (error) throw new Error(`select failed: ${error.message}`);

    const chunk = (data ?? []) as CohortRow[];
    if (!chunk.length) break;

    for (const row of chunk) {
      scanned++;
      const cur = templateTargeting(row.adset_template);
      if (!deepEqual(cur, OLD_TARGETING)) {
        skippedCustom++;
        console.log(
          `  skipped-custom cohort=${row.id} product=${row.product_id ?? "(null)"} account=${row.meta_ad_account_id ?? "(null)"} workspace=${row.workspace_id}`,
        );
        continue;
      }
      matched++;

      if (!APPLY) {
        wouldUpdate++;
        console.log(
          `  would-update  cohort=${row.id} product=${row.product_id ?? "(null)"} account=${row.meta_ad_account_id ?? "(null)"} workspace=${row.workspace_id}`,
        );
        continue;
      }

      // Compare-and-set: `.contains('adset_template', { targeting: OLD })` re-asserts the OLD
      // shape is STILL present at write-time — a hand-edit between the read above and the write
      // here fails the predicate, the update matches zero rows, and we count it as raced (never
      // clobber a custom targeting). Also re-asserts adset_per_test=true + is_active=true so a
      // concurrent retire or provision-cohort insert can't be overwritten by a stale read.
      const template = row.adset_template as Record<string, unknown>;
      const next = withNewTargeting(template);
      const { data: upData, error: upErr } = await admin
        .from("media_buyer_test_cohorts")
        .update({ adset_template: next })
        .eq("id", row.id)
        .eq("workspace_id", row.workspace_id)
        .eq("adset_per_test", true)
        .eq("is_active", true)
        .contains("adset_template", { targeting: OLD_TARGETING })
        .select("id");
      if (upErr) throw new Error(`update failed cohort=${row.id}: ${upErr.message}`);
      if (!upData?.length) {
        racedByCas++;
        console.log(
          `  raced-by-cas  cohort=${row.id} product=${row.product_id ?? "(null)"} — shape changed between read and write (safe: no overwrite)`,
        );
        continue;
      }
      updated++;
      console.log(
        `  updated       cohort=${row.id} product=${row.product_id ?? "(null)"} account=${row.meta_ad_account_id ?? "(null)"} workspace=${row.workspace_id}`,
      );
    }

    if (chunk.length < CHUNK) break;
    cursor = chunk[chunk.length - 1].id;
  }

  console.log("");
  console.log(`result: scanned=${scanned} matched-OLD=${matched} skipped-custom=${skippedCustom}`);
  if (APPLY) {
    console.log(`        updated=${updated} raced-by-cas=${racedByCas}`);
  } else {
    console.log(`        would-update=${wouldUpdate} (dry-run — re-run with --apply to write)`);
  }
})().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
