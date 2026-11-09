/**
 * Ship-time remediation for ticket `f81dd7d5-b2df-4a4b-9de6-ba7c16c56317`
 * (Mary Tanner). Marks redemption `LOYALTY-15-C5YE9N` as `used` — it was
 * genuinely delivered on her internal order SHOPCX695 (2026-11-06, $15 off the
 * Braintree charge) but, because internal orders never passed through the
 * Shopify order webhook, the row stayed `status=active` / `used_at=null`.
 *
 * Why (spec: internal-renewal-consumes-loyalty-redemption):
 * the going-forward fix makes internal renewals call `consumeRedemption` when
 * they discount a charge, so new deliveries read as `used` everywhere. This
 * one-row backfill closes the single historical row that already shipped
 * un-stamped so the orchestrator's unused-rewards list stops surfacing it and
 * Sol can't re-apply it. Per the founder call (2026-11-09) the extra $15 that
 * was already applied to her Jan 1 renewal is left in place as goodwill — this
 * script ONLY stamps the SHOPCX695 redemption used; it touches no credit, no
 * points, and no subscription.
 *
 * Idempotent by construction: delegates to [[../src/lib/loyalty]]
 * `consumeRedemption`, whose UPDATE is a compare-and-set on `used_at IS NULL`
 * AND `status IN ('active','applied')`. A re-run after the row is already
 * `used` is a no-op (returns `consumed=false`).
 *
 * Auto-ledgered on merge by [[../src/lib/ship-time-backfill-detector]]
 * `detectAndEscalateShipTimeBackfills` and drained by
 * [[../src/lib/ship-time-backfill-executor]] `executeShipTimeBackfillsForSpec`.
 *
 * Dry-run by default. Pass `--apply` (or `APPLY=1`) to write.
 *
 *   npx tsx scripts/_backfill-mary-loyalty-15-c5ye9n-used.ts
 *   npx tsx scripts/_backfill-mary-loyalty-15-c5ye9n-used.ts --apply
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";
import { consumeRedemption } from "../src/lib/loyalty";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";

// Ground-truth identifier from ticket f81dd7d5. Explicit — a one-customer
// surgical fix, not a scan.
const CODE = "LOYALTY-15-C5YE9N";

(async () => {
  const admin = createAdminClient();
  console.log(`mary_loyalty_15_c5ye9n_used_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);

  // Resolve the redemption — the source of truth for workspace + current state.
  const { data: rows, error } = await admin
    .from("loyalty_redemptions")
    .select("id, workspace_id, member_id, discount_code, discount_value, status, used_at, consumed_via")
    .ilike("discount_code", CODE);
  if (error) throw new Error(`loyalty_redemptions select failed: ${error.message}`);
  const list = rows ?? [];
  if (list.length === 0) throw new Error(`loyalty_redemptions: no row for ${CODE} — refuse to guess`);
  if (list.length > 1) throw new Error(`loyalty_redemptions: ${list.length} rows for ${CODE} — refuse to guess`);
  const red = list[0]!;
  console.log(
    `  redemption id=${red.id} workspace=${red.workspace_id} value=$${red.discount_value} status=${red.status} used_at=${red.used_at ?? "null"}`,
  );

  if (red.used_at) {
    console.log(`  already used_at=${red.used_at} consumed_via=${red.consumed_via ?? "null"} — nothing to do (idempotent)`);
    console.log("result: no-op");
    return;
  }

  if (!APPLY) {
    console.log(`  would call consumeRedemption(${red.workspace_id}, ${CODE}, "subscription_renewal")`);
    console.log("result: dry-run — re-run with --apply to write");
    return;
  }

  const { consumed, redemptionId } = await consumeRedemption(
    red.workspace_id as string,
    CODE,
    "subscription_renewal",
  );
  console.log(
    consumed
      ? `  stamped used: redemption ${redemptionId} → status=used consumed_via=subscription_renewal`
      : `  consumeRedemption no-op (row not in active/applied with used_at null) — likely already consumed by a concurrent run`,
  );
  console.log("result: applied");
})().catch((e) => {
  console.error("ERR", errText(e));
  process.exit(1);
});
