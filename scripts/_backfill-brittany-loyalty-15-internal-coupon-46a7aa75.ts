/**
 * Ship-time remediation for ticket `46a7aa75-9a09-4fbe-8aa5-fb58440f3f09`
 * (Brittany). Delivers redemption `09cbe830` (LOYALTY-15-UP77G3, member
 * `9a5e3857`, 1,500 pts spent) as a fresh INTERNAL `$15` coupon on sub
 * `0c093842` (internal `e855a0069d134f02`) — NET-ZERO on points — so the
 * discount comes off the 2026-11-15 renewal instead of silently missing.
 *
 * Why (spec:
 * loyalty-coupon-reissue-must-be-internal-sub-native-and-verify-real-value):
 * pre-fix `internalSubApplyDiscount` wrote a `{title: LOYALTY-15-UP77G3}`
 * stub and returned success unconditionally. The Shopify discount behind
 * that code cannot be durably re-resolved by `resolveCoupon`, so the
 * internal renewal path drops the entry and charges full price. Materialize
 * an internal `coupons` row (`ensureInternalLoyaltyCouponRow`) scoped to
 * the contract owner + rewrite the sub's `applied_discounts` entry to the
 * full shape (`buildAppliedDiscountEntry(resolved, code)`) so the renewal
 * hits `resolveCoupon` step 1 (internal wins) and
 * `computeAppliedDiscountCents` derives the $15 from the entry alone.
 *
 * Rails preserved: $15 loyalty ceiling (`discount_value=15`), one loyalty
 * coupon per order/renewal (`single_use=true` + `recurring_cycle_limit=1`),
 * no cash-out (points already spent by `redeem_points` at redeem time; this
 * script NEVER calls `spendPoints` or touches `loyalty_members`).
 *
 * Idempotent by construction:
 *   - `ensureInternalLoyaltyCouponRow` no-ops if the `coupons` row already
 *     exists for this code (unique on `(workspace_id, lower(code))`).
 *   - The `applied_discounts` mutation is a compare-and-set that ONLY
 *     writes when the target entry is missing or is still the pre-fix
 *     `{title}` stub — a re-run after the sub has been rewritten by the
 *     internal renewal (which stores `{code}`) or by a later apply is a
 *     safe no-op.
 *
 * Auto-ledgered on merge by [[../src/lib/ship-time-backfill-detector]]
 * `detectAndEscalateShipTimeBackfills` and drained by
 * [[../src/lib/ship-time-backfill-executor]] `executeShipTimeBackfillsForSpec`.
 *
 * Dry-run by default. Pass `--apply` (or `APPLY=1`) to write.
 *
 *   npx tsx scripts/_backfill-brittany-loyalty-15-internal-coupon-46a7aa75.ts
 *   npx tsx scripts/_backfill-brittany-loyalty-15-internal-coupon-46a7aa75.ts --apply
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import {
  buildAppliedDiscountEntry,
  appliedEntryHasRealValue,
  type AppliedDiscountResolved,
} from "../src/lib/internal-subscription";
import { insertInternalLoyaltyCouponRowUnchecked } from "../src/lib/coupons";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

// Ground-truth identifiers from the CS Director's remediation write-up on
// ticket 46a7aa75. Kept explicit — this is a one-customer surgical fix,
// not a scan.
const REDEMPTION_ID_PREFIX = "09cbe830";
const CODE = "LOYALTY-15-UP77G3";
const SUB_ID_PREFIX = "0c093842";
const MEMBER_ID_PREFIX = "9a5e3857";

async function pickExactlyOne<T>(
  label: string,
  rows: T[] | null | undefined,
): Promise<T> {
  const list = rows ?? [];
  if (list.length === 0) throw new Error(`${label}: no rows matched`);
  if (list.length > 1) throw new Error(`${label}: ${list.length} rows matched — refuse to guess`);
  return list[0]!;
}

(async () => {
  const admin = createAdminClient();

  console.log(
    `brittany_loyalty_15_internal_coupon_46a7aa75_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`,
  );

  // 1. Resolve the redemption — the source of truth for member, workspace,
  //    and discount_value. We match by code at the DB (the discount_code
  //    column is text) then narrow by id-prefix + member-prefix in memory,
  //    because loyalty_redemptions.id and .member_id are UUID and Postgres
  //    has no pattern-match operator for uuid (spec:
  //    no-sql-pattern-match-on-a-uuid-column). The triangulation
  //    fail-closed semantics are preserved — a typo in ANY of the three
  //    still leaves zero matches and pickExactlyOne throws.
  const { data: redRows, error: redErr } = await admin
    .from("loyalty_redemptions")
    .select("id, workspace_id, member_id, discount_code, discount_value, points_spent, status")
    .ilike("discount_code", CODE);
  if (redErr) throw new Error(`loyalty_redemptions select failed: ${redErr.message}`);
  const redNarrowed = (redRows ?? []).filter(
    (r) =>
      typeof r.id === "string" &&
      typeof r.member_id === "string" &&
      r.id.startsWith(REDEMPTION_ID_PREFIX) &&
      r.member_id.startsWith(MEMBER_ID_PREFIX),
  );
  const red = await pickExactlyOne("loyalty_redemptions", redNarrowed);
  console.log(
    `  redemption id=${red.id} workspace=${red.workspace_id} member=${red.member_id} value=$${red.discount_value} status=${red.status} points_spent=${red.points_spent}`,
  );

  // 2. Resolve the sub — must be internal (spec rail) and belong to the
  //    same workspace as the redemption.
  // subscriptions.id is UUID (no pattern-match operator in Postgres) — scope
  // by workspace + is_internal at the DB and narrow by id-prefix in memory
  // (spec: no-sql-pattern-match-on-a-uuid-column). The is_internal predicate
  // here is a defence-in-depth read scope; the explicit is_internal check
  // below preserves the original refuse-if-external semantics.
  const { data: subRows, error: subErr } = await admin
    .from("subscriptions")
    .select("id, workspace_id, customer_id, applied_discounts, is_internal, status, next_billing_date, shopify_contract_id")
    .eq("workspace_id", red.workspace_id)
    .eq("is_internal", true);
  if (subErr) throw new Error(`subscriptions select failed: ${subErr.message}`);
  const subNarrowed = (subRows ?? []).filter(
    (r) => typeof r.id === "string" && r.id.startsWith(SUB_ID_PREFIX),
  );
  const sub = await pickExactlyOne("subscriptions", subNarrowed);
  if (!sub.is_internal) {
    throw new Error(`sub ${sub.id} is not internal — refuse to backfill (spec: internal-sub-native)`);
  }
  if (!sub.customer_id) {
    throw new Error(`sub ${sub.id} has no customer_id — cannot scope internal coupon row`);
  }
  console.log(
    `  sub id=${sub.id} contract=${sub.shopify_contract_id} customer=${sub.customer_id} status=${sub.status} next=${sub.next_billing_date}`,
  );

  // 3. Ensure the internal coupons row (idempotent; NET-ZERO on points).
  //
  //    Uses the UNCHECKED insert helper (not `ensureInternalLoyaltyCouponRow`)
  //    per spec § Phase 3 Fix 2: "Keep any ship-time one-customer remediation
  //    explicit and separate if it must handle a previously-applied
  //    historical row." Brittany's redemption may not still be
  //    `status='active'` / `used_at IS NULL` by the time this runs, so we
  //    bypass the online-path state guard — safe here because:
  //      (a) we resolved a SPECIFIC redemption by id-prefix + code +
  //          member-prefix above (any single-column mismatch fails-closed
  //          via `pickExactlyOne`);
  //      (b) the sub's customer_id is Brittany's — the CS-Director spec
  //          write-up ties (redemption 09cbe830 → member 9a5e3857 →
  //          contract 0c093842); AND
  //      (c) idempotency: read-first below so a re-run after the first
  //          insert is a no-op, and the internal coupons row's unique
  //          `(workspace_id, lower(code))` index prevents a second insert
  //          under any race.
  //
  //    Read-first idempotency (unique index would raise otherwise).
  const { data: existingCoupon } = await admin
    .from("coupons")
    .select("id, value")
    .eq("workspace_id", red.workspace_id)
    .ilike("code", CODE.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&"))
    .maybeSingle();

  if (existingCoupon) {
    console.log(
      `  coupons row already exists id=${existingCoupon.id} value=${existingCoupon.value} cents — skip insert (idempotent)`,
    );
  } else if (!APPLY) {
    console.log(
      `  would-insert internal coupons row: code=${CODE} customer=${sub.customer_id} value=$${red.discount_value} single_use=true recurring_cycle_limit=1`,
    );
  } else {
    const valueCents = Math.round(Number(red.discount_value) * 100);
    const materialized = await insertInternalLoyaltyCouponRowUnchecked(
      admin,
      red.workspace_id as string,
      CODE,
      sub.customer_id as string,
      valueCents,
    );
    if (!materialized) {
      throw new Error(
        `insertInternalLoyaltyCouponRowUnchecked returned null — likely lost a race to a concurrent inserter; re-run to observe the winner via the read-first path`,
      );
    }
    console.log(
      `  inserted internal coupons row: id=${materialized.coupon_id} code=${materialized.code} value=${materialized.value} cents source=${materialized.source}`,
    );
  }

  // 4. Compare-and-set the applied_discounts entry to full-shape ONLY when
  //    it's absent or is still the pre-fix `{title}` stub. A re-run after
  //    the sub has been rewritten to a full-shape entry (or after the
  //    internal renewal has consumed it) is a safe no-op.
  const existing = Array.isArray(sub.applied_discounts)
    ? (sub.applied_discounts as Array<Record<string, unknown>>)
    : [];
  const upper = CODE.toUpperCase();
  const idx = existing.findIndex((d) => {
    const t = typeof d?.title === "string" ? d.title.toUpperCase() : "";
    const c = typeof d?.code === "string" ? d.code.toUpperCase() : "";
    return t === upper || c === upper;
  });
  const current = idx >= 0 ? existing[idx] : null;
  const alreadyFullShape = current != null && appliedEntryHasRealValue(current);

  const resolved: AppliedDiscountResolved = {
    code: CODE,
    type: "fixed_amount",
    value: Math.round(Number(red.discount_value) * 100),
    recurring_cycle_limit: 1,
    source: "internal",
  };
  const nextEntry = buildAppliedDiscountEntry(resolved, CODE);

  if (alreadyFullShape) {
    console.log(
      `  applied_discounts[${idx}] already full-shape (${JSON.stringify(current)}) — no rewrite needed`,
    );
  } else {
    const nextArr =
      idx >= 0
        ? existing.map((d, i) => (i === idx ? nextEntry : d))
        : [...existing, nextEntry];
    if (!APPLY) {
      console.log(
        `  would-write applied_discounts[${idx >= 0 ? idx : "append"}] = ${JSON.stringify(nextEntry)}`,
      );
    } else {
      // Compare-and-set: assert the applied_discounts we read is the one
      // we're overwriting (a concurrent apply/remove that landed between
      // our read and our write should NOT be clobbered).
      const { data: upData, error: upErr } = await admin
        .from("subscriptions")
        .update({ applied_discounts: nextArr, updated_at: new Date().toISOString() })
        .eq("id", sub.id)
        .eq("workspace_id", sub.workspace_id)
        .eq("applied_discounts", JSON.stringify(existing))
        .select("id");
      if (upErr) throw new Error(`applied_discounts update failed: ${upErr.message}`);
      if (!upData?.length) {
        console.log(
          `  raced-by-cas sub=${sub.id} — applied_discounts changed between read and write (safe: no overwrite; re-run picks up the winner)`,
        );
      } else {
        console.log(
          `  wrote    applied_discounts[${idx >= 0 ? idx : "append"}] = ${JSON.stringify(nextEntry)}`,
        );
      }
    }
  }

  console.log("");
  console.log(APPLY ? "result: applied" : "result: dry-run — re-run with --apply to write");
})().catch((e) => {
  console.error("ERR", errText(e));
  process.exit(1);
});
