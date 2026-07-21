/**
 * One-shot backfill: stamp the last-180d purchasers exclusion on every ACTIVE per-test
 * cohort whose `excluded_purchaser_audience_id` is NULL, and compose it into the
 * cohort's `adset_template.targeting.excluded_custom_audiences` so newly-minted per-test
 * ad sets inherit it on publish.
 *
 * Why: Phase 2 wires provisionProductTestCohort + buildAdsetTemplate to STAMP the
 * exclusion on freshly-provisioned cohorts, and Phase 3 (this) adds the publish-gate rail
 * that refuses `missing_purchaser_exclusion`. But every ALREADY-active per-test cohort
 * (Amazing Coffee, Creamer, Guru Focus, Zen Relax) still mints future per-test ad sets
 * WITHOUT the exclusion until we stamp it on the DB row. This backfill does exactly that
 * per (workspace, ad_account, pixel): find-or-create the audience via
 * [[../src/lib/meta-ads]] `getOrCreateRecentPurchaserAudience` (Phase 1 helper, idempotent),
 * then upsert `excluded_purchaser_audience_id = <id>` + rewrite `adset_template.targeting`
 * to carry `excluded_custom_audiences: [{ id }]`.
 *
 * Match rule: a row is UPDATED only if its `adset_template.targeting.excluded_custom_audiences`
 * is currently absent (the pre-Phase-3 shape). Any custom-edited row that already carries an
 * `excluded_custom_audiences` array is SKIPPED — never overwritten. The write is a
 * compare-and-set: the update re-asserts `excluded_purchaser_audience_id IS NULL` AND the
 * old (no-exclusion) `adset_template.targeting` shape at write-time, so a hand-edit or a
 * concurrent provision-cohort insert between our read and our write can't be clobbered.
 *
 * Idempotent — re-running after a successful pass finds zero matches (every row already has
 * `excluded_purchaser_audience_id`) and exits clean. Auto-ledgered by the post-merge
 * [[../src/lib/ship-time-backfill-detector]] (the `scripts/_backfill-*.ts` filename
 * convention triggers the pending `data_op_runs` row + CEO card) and drained on the box by
 * [[../src/lib/ship-time-backfill-executor]] `executeShipTimeBackfillsForSpec`.
 *
 * Dry-run by default (safe to run any time). Pass `--apply` to write; `APPLY=1` also works.
 *
 *   npx tsx scripts/_backfill-cold-test-recent-purchaser-exclusion.ts            # dry-run
 *   npx tsx scripts/_backfill-cold-test-recent-purchaser-exclusion.ts --apply    # write
 *
 * Spec: docs/brain/specs/bianca-cold-test-recent-purchaser-exclusion Phase 3.
 */
import "./_bootstrap";
import { errText } from "../src/lib/error-text";
import { createAdminClient } from "../src/lib/supabase/admin";
import { getMetaUserToken, getOrCreateRecentPurchaserAudience } from "../src/lib/meta-ads";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const CHUNK = 500;
const RETENTION_DAYS = 180;

type CohortRow = {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  product_id: string | null;
  adset_per_test: boolean;
  is_active: boolean;
  adset_template: Record<string, unknown> | null;
  excluded_purchaser_audience_id: string | null;
};

type MetaAdAccountRow = {
  id: string;
  meta_ad_account_id: string; // the bare Meta act id
};

/** Pull the pixelId off `adset_template` (structural; null-safe). */
function templatePixelId(t: CohortRow["adset_template"]): string | null {
  if (!t || typeof t !== "object") return null;
  const v = (t as Record<string, unknown>).pixelId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Pull `.targeting` off `adset_template`. Null-safe. */
function templateTargeting(t: CohortRow["adset_template"]): Record<string, unknown> | null {
  if (!t || typeof t !== "object") return null;
  const v = (t as Record<string, unknown>).targeting;
  if (!v || typeof v !== "object") return null;
  return v as Record<string, unknown>;
}

/** True when the targeting is missing the `excluded_custom_audiences` key (or it's an empty array).
 *  A cohort whose template ALREADY carries a non-empty exclusion list is treated as custom and skipped. */
function hasNoExclusionShape(targeting: Record<string, unknown> | null): boolean {
  if (!targeting) return true;
  const raw = targeting.excluded_custom_audiences;
  if (raw === undefined || raw === null) return true;
  return Array.isArray(raw) && raw.length === 0;
}

/**
 * Deep-clone the template, rewriting `.targeting.excluded_custom_audiences` to `[{ id }]`.
 * Preserves every other targeting field (age band, geo, genders, targeting_automation, …).
 * Never mutates the input.
 */
function withExclusion(t: Record<string, unknown>, audienceId: string): Record<string, unknown> {
  const currentTargeting = templateTargeting(t) ?? {};
  const nextTargeting = { ...currentTargeting, excluded_custom_audiences: [{ id: audienceId }] };
  return { ...t, targeting: nextTargeting };
}

(async () => {
  const admin = createAdminClient();

  console.log(`cold_test_recent_purchaser_exclusion_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  retentionDays=${RETENTION_DAYS} (Meta's max, per founder refinement 2026-07-15)\n`);

  // Cursor-paginated read of every ACTIVE per-test cohort still missing the exclusion.
  // Ordered by `id` for a stable cursor across chunks even if new rows land mid-scan.
  let cursor: string | null = null;
  let scanned = 0;
  let missingConfig = 0; // no pixelId on template, or no matching meta_ad_accounts row → can't get an audience
  let missingToken = 0; // workspace has no active Meta connection
  let skippedCustom = 0; // template already carries a non-empty excluded_custom_audiences
  let audienceReused = 0; // find-or-create hit — audience already existed
  let audienceCreated = 0; // audience POSTed (only in APPLY mode)
  let wouldStamp = 0; // dry-run: would have stamped
  let stamped = 0; // apply: successfully stamped
  let racedByCas = 0; // apply: CAS predicate blocked the write

  // The audience id per (workspace, ad_account, pixel) — reused across rows so a shared
  // account+pixel only calls `getOrCreateRecentPurchaserAudience` once per run.
  const audienceCache = new Map<string, string>();

  for (;;) {
    let q = admin
      .from("media_buyer_test_cohorts")
      .select("id, workspace_id, meta_ad_account_id, product_id, adset_per_test, is_active, adset_template, excluded_purchaser_audience_id")
      .eq("adset_per_test", true)
      .eq("is_active", true)
      .is("excluded_purchaser_audience_id", null)
      .order("id", { ascending: true })
      .limit(CHUNK);
    if (cursor) q = q.gt("id", cursor);

    const { data, error } = await q;
    if (error) throw new Error(`select failed: ${error.message}`);

    const chunk = (data ?? []) as CohortRow[];
    if (!chunk.length) break;

    for (const row of chunk) {
      scanned++;

      const pixelId = templatePixelId(row.adset_template);
      if (!pixelId || !row.meta_ad_account_id) {
        missingConfig++;
        console.log(
          `  missing-config cohort=${row.id} product=${row.product_id ?? "(null)"} ` +
            `— ${!pixelId ? "no pixelId on template" : "no meta_ad_account_id"} (skipped)`,
        );
        continue;
      }

      const targeting = templateTargeting(row.adset_template);
      if (!hasNoExclusionShape(targeting)) {
        skippedCustom++;
        console.log(
          `  skipped-custom cohort=${row.id} product=${row.product_id ?? "(null)"} ` +
            `— targeting.excluded_custom_audiences already set (never overwritten)`,
        );
        continue;
      }

      // Resolve the bare Meta act id from meta_ad_accounts.id (our uuid). The audience
      // must be created against the account's Meta act id, not our uuid.
      const { data: accts, error: acctErr } = await admin
        .from("meta_ad_accounts")
        .select("id, meta_ad_account_id")
        .eq("id", row.meta_ad_account_id)
        .limit(1);
      if (acctErr) throw new Error(`meta_ad_accounts read failed cohort=${row.id}: ${acctErr.message}`);
      const acct = ((accts ?? [])[0] ?? null) as MetaAdAccountRow | null;
      if (!acct?.meta_ad_account_id) {
        missingConfig++;
        console.log(
          `  missing-config cohort=${row.id} product=${row.product_id ?? "(null)"} — no meta_ad_accounts row (skipped)`,
        );
        continue;
      }

      const cacheKey = `${row.workspace_id}|${acct.meta_ad_account_id}|${pixelId}`;
      let audienceId = audienceCache.get(cacheKey) ?? null;

      if (!audienceId) {
        // APPLY-only: call Meta. In dry-run we log the intent and count what WOULD happen.
        if (!APPLY) {
          wouldStamp++;
          console.log(
            `  would-stamp    cohort=${row.id} product=${row.product_id ?? "(null)"} ` +
              `account=${acct.meta_ad_account_id} pixel=${pixelId} ` +
              `— dry-run: would find-or-create the last-${RETENTION_DAYS}d purchasers audience + stamp`,
          );
          continue;
        }

        const token = await getMetaUserToken(row.workspace_id);
        if (!token) {
          missingToken++;
          console.log(
            `  missing-token  cohort=${row.id} workspace=${row.workspace_id} — no active meta_connections (skipped)`,
          );
          continue;
        }

        // Find-first: listCustomAudiences → returns the existing id if the canonical
        // name is already in the account. Otherwise POST /customaudiences to create it.
        const before = audienceCache.size;
        try {
          audienceId = await getOrCreateRecentPurchaserAudience(token, acct.meta_ad_account_id, pixelId, {
            retentionDays: RETENTION_DAYS,
          });
        } catch (e) {
          console.log(
            `  audience-error cohort=${row.id} workspace=${row.workspace_id} — ${errText(e)} (skipped)`,
          );
          continue;
        }
        audienceCache.set(cacheKey, audienceId);
        // Best-effort attribution: if audienceCache grew, we called Meta this cycle.
        // We can't distinguish reuse from create without a second Graph call — treat the
        // FIRST call for a cacheKey as "resolved from Meta" and let the log tell the story.
        if (audienceCache.size > before) audienceCreated++;
      } else {
        audienceReused++;
      }

      if (!APPLY) {
        // Cached hit in a dry-run pass (rare — different rows for the same account+pixel).
        wouldStamp++;
        console.log(
          `  would-stamp    cohort=${row.id} product=${row.product_id ?? "(null)"} ` +
            `account=${acct.meta_ad_account_id} pixel=${pixelId} audience=${audienceId} — dry-run: would stamp`,
        );
        continue;
      }

      // Compare-and-set: re-assert (a) `excluded_purchaser_audience_id IS NULL` (we're the
      // first to stamp it) AND (b) `adset_per_test=true`+`is_active=true` (a concurrent
      // retire can't have swapped in) AND (c) the template's CURRENT no-exclusion shape
      // ALWAYS. A hand-edit adding an exclusion between the read above and the write here
      // fails the predicate, the update matches zero rows, and we count it as raced — the
      // rail must hold for BOTH read-time shapes:
      //   • absent key   — the pre-Phase-3 common case: the write filters on the JSON path
      //     `adset_template->targeting->excluded_custom_audiences IS NULL`. `->` returns SQL
      //     NULL when the key is missing OR the value is JSON null, so this covers both.
      //   • empty array  — a legacy row whose template already carries `[]`: the write uses
      //     `.contains('adset_template', { targeting: { excluded_custom_audiences: [] } })`,
      //     the jsonb subset-match that only holds while the array is still empty.
      // A concurrent hand-edit that adds an entry drops both predicates and races us out.
      const nextTemplate = withExclusion(row.adset_template ?? {}, audienceId);
      let upQ = admin
        .from("media_buyer_test_cohorts")
        .update({
          excluded_purchaser_audience_id: audienceId,
          adset_template: nextTemplate,
        })
        .eq("id", row.id)
        .eq("workspace_id", row.workspace_id)
        .eq("adset_per_test", true)
        .eq("is_active", true)
        .is("excluded_purchaser_audience_id", null);
      if (targeting && Array.isArray(targeting.excluded_custom_audiences)) {
        // Read-time shape was `[]` (empty array). Compare-and-set on the SAME empty array —
        // a concurrent hand-edit that appends an entry drops the subset match.
        upQ = upQ.contains("adset_template", { targeting: { excluded_custom_audiences: [] } });
      } else {
        // Read-time shape was absent-key (or JSON null). Compare-and-set on the JSON path
        // being NULL at write time — a concurrent hand-edit that sets the key to any array
        // (empty or non-empty) drops this predicate.
        upQ = upQ.filter("adset_template->targeting->excluded_custom_audiences", "is", "null");
      }
      const { data: upData, error: upErr } = await upQ.select("id");
      if (upErr) throw new Error(`update failed cohort=${row.id}: ${upErr.message}`);
      if (!upData?.length) {
        racedByCas++;
        console.log(
          `  raced-by-cas   cohort=${row.id} product=${row.product_id ?? "(null)"} ` +
            `— shape changed between read and write (safe: no overwrite)`,
        );
        continue;
      }
      stamped++;
      console.log(
        `  stamped        cohort=${row.id} product=${row.product_id ?? "(null)"} ` +
          `account=${acct.meta_ad_account_id} audience=${audienceId}`,
      );
    }

    if (chunk.length < CHUNK) break;
    cursor = chunk[chunk.length - 1].id;
  }

  console.log("");
  console.log(
    `result: scanned=${scanned} missing-config=${missingConfig} missing-token=${missingToken} ` +
      `skipped-custom=${skippedCustom}`,
  );
  if (APPLY) {
    console.log(
      `        audience-resolved=${audienceCreated} audience-reused-from-cache=${audienceReused} ` +
        `stamped=${stamped} raced-by-cas=${racedByCas}`,
    );
  } else {
    console.log(`        would-stamp=${wouldStamp} (dry-run — re-run with --apply to write)`);
  }
})().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
