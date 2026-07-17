/**
 * One-shot backfill: stamp the all-customers (CUSTOMER_LIST, hashed) exclusion on every
 * ACTIVE per-test cohort whose `excluded_all_customers_audience_id` is NULL, and compose
 * it into the cohort's `adset_template.targeting.excluded_custom_audiences` so newly-minted
 * per-test ad sets inherit it on publish. Sibling of `_backfill-cold-test-recent-purchaser-exclusion.ts`
 * for the second exclusion audience.
 *
 * Why: bianca-full-order-history-customer-list-exclusion-audience Fix 1 wires provision + replenish
 * + publish-gate to require BOTH exclusion ids (purchaser + all-customers). Every ALREADY-active
 * per-test cohort still mints future per-test ad sets WITHOUT the all-customers exclusion until we
 * stamp it on the DB row. This backfill does exactly that per (workspace, ad_account):
 *
 *   1. find-or-create the CUSTOMER_LIST audience via [[../src/lib/meta-ads]] `getOrCreateAllCustomersAudience`
 *      (idempotent, subtype='CUSTOMER_LIST', customer_file_source='USER_PROVIDED_ONLY');
 *   2. upload every customer who has ever ordered (customers.total_orders >= 1 / first_order_at not null
 *      — reflects all three order sources: Shopify, Internal, Amazon) via `addUsersToCustomAudience`
 *      — hashed email + phone only (no plaintext PII persisted or logged);
 *   3. compare-and-set stamp `excluded_all_customers_audience_id = <id>` + append `{ id }` to
 *      `adset_template.targeting.excluded_custom_audiences` (append, not overwrite — a cohort that
 *      already carries the sibling purchaser id keeps it).
 *
 * Match rule: a row is UPDATED only if its `excluded_all_customers_audience_id IS NULL` AND its
 * template's `excluded_custom_audiences` does NOT already list the all-customers id (a re-run after
 * a raced upload finds nothing). The write is compare-and-set on those two predicates + workspace_id
 * + is_active + adset_per_test so a concurrent hand-edit or a retire between our read and our write
 * races us out rather than being clobbered.
 *
 * Idempotent — re-running after a successful pass finds zero matches and exits clean. Auto-ledgered
 * by the post-merge [[../src/lib/ship-time-backfill-detector]] (the `scripts/_backfill-*.ts` filename
 * convention triggers the pending `data_op_runs` row + CEO card) and drained on the box by
 * [[../src/lib/ship-time-backfill-executor]] `executeShipTimeBackfillsForSpec`.
 *
 * Dry-run by default (safe to run any time). Pass `--apply` to write; `APPLY=1` also works.
 *
 *   npx tsx scripts/_backfill-cold-test-all-customers-exclusion.ts            # dry-run
 *   npx tsx scripts/_backfill-cold-test-all-customers-exclusion.ts --apply    # write
 *
 * Spec: docs/brain/specs/bianca-full-order-history-customer-list-exclusion-audience Fix 1.
 */
import "./_bootstrap";
import { createAdminClient } from "../src/lib/supabase/admin";
import {
  addUsersToCustomAudience,
  getMetaUserToken,
  getOrCreateAllCustomersAudience,
} from "../src/lib/meta-ads";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const COHORT_CHUNK = 500;
const CUSTOMER_CHUNK = 10_000;

type CohortRow = {
  id: string;
  workspace_id: string;
  meta_ad_account_id: string | null;
  product_id: string | null;
  adset_per_test: boolean;
  is_active: boolean;
  adset_template: Record<string, unknown> | null;
  excluded_all_customers_audience_id: string | null;
};

type MetaAdAccountRow = {
  id: string;
  meta_ad_account_id: string;
};

function templateTargeting(t: CohortRow["adset_template"]): Record<string, unknown> | null {
  if (!t || typeof t !== "object") return null;
  const v = (t as Record<string, unknown>).targeting;
  if (!v || typeof v !== "object") return null;
  return v as Record<string, unknown>;
}

function alreadyExcluded(targeting: Record<string, unknown> | null, audienceId: string): boolean {
  if (!targeting) return false;
  const raw = targeting.excluded_custom_audiences;
  if (!Array.isArray(raw)) return false;
  for (const entry of raw) {
    if (entry && typeof entry === "object" && (entry as Record<string, unknown>).id === audienceId) return true;
  }
  return false;
}

/**
 * Deep-clone the template, appending `{ id: audienceId }` to `.targeting.excluded_custom_audiences`
 * (preserving any existing entries — this is the SECOND exclusion audience, layered on top of the
 * first). Never mutates the input.
 */
function withExclusionAppended(
  t: Record<string, unknown>,
  audienceId: string,
): Record<string, unknown> {
  const currentTargeting = templateTargeting(t) ?? {};
  const rawList = currentTargeting.excluded_custom_audiences;
  const existing = Array.isArray(rawList) ? rawList : [];
  for (const entry of existing) {
    if (entry && typeof entry === "object" && (entry as Record<string, unknown>).id === audienceId) {
      return t;
    }
  }
  const nextTargeting = {
    ...currentTargeting,
    excluded_custom_audiences: [...existing, { id: audienceId }],
  };
  return { ...t, targeting: nextTargeting };
}

(async () => {
  const admin = createAdminClient();

  console.log(`cold_test_all_customers_exclusion_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  console.log(`  hashed CUSTOMER_LIST audience per (workspace, ad_account) — bianca Fix 1\n`);

  let cursor: string | null = null;
  let scanned = 0;
  let missingConfig = 0;
  let missingToken = 0;
  let skippedAlreadyExcluded = 0;
  let audienceReused = 0;
  let audienceResolved = 0;
  let uploadedRows = 0;
  let wouldStamp = 0;
  let stamped = 0;
  let racedByCas = 0;

  const audienceCache = new Map<string, string>(); // (workspace|act) → audience id
  const uploadedFor = new Set<string>(); // (workspace|act) already uploaded this run

  for (;;) {
    let q = admin
      .from("media_buyer_test_cohorts")
      .select(
        "id, workspace_id, meta_ad_account_id, product_id, adset_per_test, is_active, adset_template, excluded_all_customers_audience_id",
      )
      .eq("adset_per_test", true)
      .eq("is_active", true)
      .is("excluded_all_customers_audience_id", null)
      .order("id", { ascending: true })
      .limit(COHORT_CHUNK);
    if (cursor) q = q.gt("id", cursor);

    const { data, error } = await q;
    if (error) throw new Error(`select failed: ${error.message}`);

    const chunk = (data ?? []) as CohortRow[];
    if (!chunk.length) break;

    for (const row of chunk) {
      scanned++;

      if (!row.meta_ad_account_id) {
        missingConfig++;
        console.log(
          `  missing-config cohort=${row.id} product=${row.product_id ?? "(null)"} — no meta_ad_account_id (skipped)`,
        );
        continue;
      }

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

      const cacheKey = `${row.workspace_id}|${acct.meta_ad_account_id}`;
      let audienceId = audienceCache.get(cacheKey) ?? null;

      if (!audienceId) {
        if (!APPLY) {
          wouldStamp++;
          console.log(
            `  would-stamp    cohort=${row.id} product=${row.product_id ?? "(null)"} ` +
              `account=${acct.meta_ad_account_id} — dry-run: would find-or-create the all-customers audience + upload + stamp`,
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

        try {
          audienceId = await getOrCreateAllCustomersAudience(token, acct.meta_ad_account_id);
        } catch (e) {
          console.log(
            `  audience-error cohort=${row.id} workspace=${row.workspace_id} — ${e instanceof Error ? e.message : String(e)} (skipped)`,
          );
          continue;
        }
        audienceCache.set(cacheKey, audienceId);
        audienceResolved++;

        // Upload every customer who has ever ordered — once per (workspace, ad_account) per run.
        if (!uploadedFor.has(cacheKey)) {
          let uploadCursor: string | null = null;
          for (;;) {
            let cq = admin
              .from("customers")
              .select("id, email, phone")
              .eq("workspace_id", row.workspace_id)
              .gte("total_orders", 1)
              .order("id", { ascending: true })
              .limit(CUSTOMER_CHUNK);
            if (uploadCursor) cq = cq.gt("id", uploadCursor);
            const { data: rows, error: cErr } = await cq;
            if (cErr) throw new Error(`customers read failed: ${cErr.message}`);
            const customers = (rows ?? []) as Array<{ id: string; email: string | null; phone: string | null }>;
            if (!customers.length) break;
            const uploadRows = customers.map((c) => ({ email: c.email, phone: c.phone }));
            const results = await addUsersToCustomAudience(token, audienceId, uploadRows);
            for (const r of results) uploadedRows += r.num_received;
            if (customers.length < CUSTOMER_CHUNK) break;
            uploadCursor = customers[customers.length - 1].id;
          }
          uploadedFor.add(cacheKey);
          console.log(
            `  audience-ready cohort=${row.id} account=${acct.meta_ad_account_id} audience=${audienceId} — uploaded so far ${uploadedRows} row(s)`,
          );
        }
      } else {
        audienceReused++;
      }

      if (!APPLY) {
        wouldStamp++;
        console.log(
          `  would-stamp    cohort=${row.id} product=${row.product_id ?? "(null)"} ` +
            `account=${acct.meta_ad_account_id} audience=${audienceId} — dry-run: would stamp`,
        );
        continue;
      }

      const targeting = templateTargeting(row.adset_template);
      if (alreadyExcluded(targeting, audienceId)) {
        // Nothing to do at the template layer; still stamp the id if the CAS says NULL.
        skippedAlreadyExcluded++;
      }
      const nextTemplate = withExclusionAppended(row.adset_template ?? {}, audienceId);
      const { data: upData, error: upErr } = await admin
        .from("media_buyer_test_cohorts")
        .update({
          excluded_all_customers_audience_id: audienceId,
          adset_template: nextTemplate,
        })
        .eq("id", row.id)
        .eq("workspace_id", row.workspace_id)
        .eq("adset_per_test", true)
        .eq("is_active", true)
        .is("excluded_all_customers_audience_id", null)
        .select("id");
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

    if (chunk.length < COHORT_CHUNK) break;
    cursor = chunk[chunk.length - 1].id;
  }

  console.log("");
  console.log(
    `result: scanned=${scanned} missing-config=${missingConfig} missing-token=${missingToken} ` +
      `already-excluded=${skippedAlreadyExcluded}`,
  );
  if (APPLY) {
    console.log(
      `        audience-resolved=${audienceResolved} audience-reused-from-cache=${audienceReused} ` +
        `uploaded-rows=${uploadedRows} stamped=${stamped} raced-by-cas=${racedByCas}`,
    );
  } else {
    console.log(`        would-stamp=${wouldStamp} (dry-run — re-run with --apply to write)`);
  }
})().catch((e) => {
  console.error("ERR", e instanceof Error ? e.message : e);
  process.exit(1);
});
