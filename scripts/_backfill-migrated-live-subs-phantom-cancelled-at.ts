/**
 * Ship-time backfill: clear the phantom `cancelled_at` the Appstle→internal migration stamped
 * onto subscriptions that stayed LIVE.
 *
 * The migration used to cancel the old Appstle contract with a customer-style cancel
 * (`subscriptionAction(..., "cancel")`), which also wrote cancel-truth onto OUR row —
 * status='cancelled' + `cancelled_at` — seconds before the flip. The flip restored `status`
 * but never cleared `cancelled_at`, so a live migrated sub carried a cancellation date it never
 * had (the CS director's cancellation timeline renders it; `resolveSub` sorts on it). The code
 * fix (vendor-only cancel + the flip clearing `cancelled_at`) stops new ones; this clears the
 * existing ones. Measured 2026-10-01: 33 live migrated subs, every stamp within 2 minutes
 * BEFORE its own migration audit row.
 *
 * Auto-ledgered on merge by [[../src/lib/ship-time-backfill-detector]]
 * `detectAndEscalateShipTimeBackfills`; run on the box by [[../src/lib/ship-time-backfill-executor]].
 *
 * NARROW BY CONSTRUCTION — a row is cleared only when ALL hold:
 *   1. `is_internal = true` AND `status in ('active','paused')` AND `cancelled_at is not null`
 *   2. `migrated_from_contract_id is not null` (it was migrated)
 *   3. it has a `migration_audits` row whose `created_at` is AT OR AFTER `cancelled_at` and at
 *      most `WINDOW_MS` after it — i.e. the stamp was written by the migration itself, in the
 *      seconds before the flip. A sub genuinely cancelled later (and reactivated) has a stamp
 *      AFTER its migration and is left alone.
 * Idempotent: the write is a compare-and-set on the exact `cancelled_at` value read plus the
 * live statuses, so a re-run finds nothing and a concurrent real cancel is never overwritten.
 *
 * Dry-run by default. Pass `--apply` (or `APPLY=1`) to write.
 *
 *   npx tsx scripts/_backfill-migrated-live-subs-phantom-cancelled-at.ts            # dry-run
 *   npx tsx scripts/_backfill-migrated-live-subs-phantom-cancelled-at.ts --apply    # write
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const CHUNK = 200;
const LIVE = ["active", "paused"];
/** How far before its migration audit row a stamp may sit and still be the migration's own. */
export const WINDOW_MS = 5 * 60 * 1000;

/**
 * Pure: true iff `cancelledAt` was written by the migration — at or before one of the sub's
 * migration audit timestamps, and no more than `windowMs` before it.
 */
export function isMigrationStampedCancelledAt(
  cancelledAt: string | null,
  auditCreatedAts: readonly string[],
  windowMs: number = WINDOW_MS,
): boolean {
  if (!cancelledAt) return false;
  const c = new Date(cancelledAt).getTime();
  if (!Number.isFinite(c)) return false;
  return auditCreatedAts.some((a) => {
    const t = new Date(a).getTime();
    return Number.isFinite(t) && t >= c && t - c <= windowMs;
  });
}

interface SubRow {
  id: string;
  workspace_id: string;
  status: string;
  cancelled_at: string | null;
}

async function main(): Promise<void> {
  const admin = createAdminClient();
  console.log(`migrated_live_subs_phantom_cancelled_at_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);

  let cursor: string | null = null;
  let scanned = 0;
  let eligible = 0;
  let cleared = 0;
  let leftAlone = 0;
  let racedByCas = 0;

  for (;;) {
    let q = admin
      .from("subscriptions")
      .select("id, workspace_id, status, cancelled_at")
      .eq("is_internal", true)
      .in("status", LIVE)
      .not("cancelled_at", "is", null)
      .not("migrated_from_contract_id", "is", null)
      .order("id", { ascending: true })
      .limit(CHUNK);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) throw new Error(`subscriptions select failed: ${error.message}`);
    const subs = (data ?? []) as SubRow[];
    if (!subs.length) break;
    cursor = subs[subs.length - 1].id;

    const { data: audits, error: aErr } = await admin
      .from("migration_audits")
      .select("subscription_id, created_at")
      .in("subscription_id", subs.map((s) => s.id));
    if (aErr) throw new Error(`migration_audits select failed: ${aErr.message}`);
    const auditTimes = new Map<string, string[]>();
    for (const a of audits ?? []) {
      const k = a.subscription_id as string;
      auditTimes.set(k, [...(auditTimes.get(k) ?? []), a.created_at as string]);
    }

    for (const s of subs) {
      scanned++;
      if (!isMigrationStampedCancelledAt(s.cancelled_at, auditTimes.get(s.id) ?? [])) {
        leftAlone++;
        continue;
      }
      eligible++;
      console.log(`  ${APPLY ? "clear" : "would clear"} sub ${s.id} (${s.status}) cancelled_at=${s.cancelled_at}`);
      if (!APPLY) continue;
      const { data: upd, error: uErr } = await admin
        .from("subscriptions")
        .update({ cancelled_at: null, updated_at: new Date().toISOString() })
        .eq("id", s.id)
        .eq("workspace_id", s.workspace_id)
        .eq("cancelled_at", s.cancelled_at as string)
        .in("status", LIVE)
        .select("id");
      if (uErr) throw new Error(`update ${s.id} failed: ${uErr.message}`);
      if (upd?.length) cleared++;
      else racedByCas++;
    }
  }

  console.log(
    `\nscanned=${scanned} eligible=${eligible} ${APPLY ? `cleared=${cleared} raced=${racedByCas}` : "(dry-run, nothing written)"} left_alone=${leftAlone}`,
  );
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error("ERR", errText(e));
    process.exit(1);
  });
}
