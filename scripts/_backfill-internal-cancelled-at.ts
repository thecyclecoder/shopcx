/**
 * Ship-time backfill: stamp `cancelled_at` on INTERNAL cancelled subscriptions that never got one.
 *
 * The internal cancel writers (internalSubscriptionAction, internal dunning exhaustion, the
 * cancel-journey fallback) set status='cancelled' + next_billing_date=null but never stamped
 * `cancelled_at`, unlike the Appstle / ShopCX paths (fixed alongside: stampCancelledAtIfUnset).
 * Measured 2026-10-08: 353 internal cancelled subs with no date — 293 migrated already-cancelled
 * from Appstle, the rest cancelled on internal rails.
 *
 * EVIDENCE ONLY — a date is written only when there is a real source for it:
 *   1. the latest cancel event carrying this subscription's id (`subscription.cancelled` /
 *      `portal.subscription.cancelled` in customer_events — dunning, agent, portal cancels);
 *   2. for a sub migrated while ALREADY cancelled: the latest Appstle `subscription.cancelled`
 *      webhook event logged for its origin contract (customer_events, source='appstle',
 *      properties.shopify_contract_id = migrated_from_contract_id) dated no later than the
 *      migration. (appstle_contract_snapshots was checked too: it never covered this cohort.)
 * Anything else is LEFT NULL and counted — an unknown date stays unknown rather than invented.
 *
 * Auto-ledgered on merge by [[../src/lib/ship-time-backfill-detector]]; run on the box by
 * [[../src/lib/ship-time-backfill-executor]]. Idempotent: the write is a compare-and-set on
 * `cancelled_at IS NULL AND status = 'cancelled'`, so a re-run finds nothing and a concurrent
 * real cancel's stamp is never overwritten.
 *
 *   npx tsx scripts/_backfill-internal-cancelled-at.ts            # dry-run
 *   npx tsx scripts/_backfill-internal-cancelled-at.ts --apply    # write
 */
import { createAdminClient } from "./_bootstrap";
import { errText } from "../src/lib/error-text";

const APPLY = process.argv.includes("--apply") || process.env.APPLY === "1";
const CHUNK = 200;

export interface CancelEvidence {
  /** Latest cancel event created_at for this sub, if any. */
  cancelEventAt: string | null;
  /** The sub migrated while already cancelled (subscription.migrated event status='cancelled'). */
  migratedAsCancelledAt: string | null;
  /** created_at of the latest Appstle `subscription.cancelled` webhook event for the origin contract. */
  appstleCancelEventAt: string | null;
}

/** Pure: the evidenced cancellation timestamp, or null when there is none. */
export function pickCancelledAt(e: CancelEvidence): { at: string; source: "cancel_event" | "appstle_cancel_webhook" } | null {
  if (e.cancelEventAt && Number.isFinite(Date.parse(e.cancelEventAt))) return { at: e.cancelEventAt, source: "cancel_event" };
  if (
    e.migratedAsCancelledAt &&
    e.appstleCancelEventAt &&
    Number.isFinite(Date.parse(e.appstleCancelEventAt)) &&
    Date.parse(e.appstleCancelEventAt) <= Date.parse(e.migratedAsCancelledAt)
  ) {
    return { at: e.appstleCancelEventAt, source: "appstle_cancel_webhook" };
  }
  return null;
}

interface SubRow { id: string; workspace_id: string; migrated_from_contract_id: string | null }

async function main(): Promise<void> {
  const admin = createAdminClient();
  console.log(`internal_cancelled_at_backfill — ${APPLY ? "APPLY" : "DRY-RUN"}`);
  let cursor: string | null = null;
  const tally = { scanned: 0, cancel_event: 0, appstle_cancel_webhook: 0, no_evidence: 0, written: 0, raced: 0 };

  for (;;) {
    let q = admin
      .from("subscriptions")
      .select("id, workspace_id, migrated_from_contract_id")
      .eq("is_internal", true)
      .eq("status", "cancelled")
      .is("cancelled_at", null)
      .order("id", { ascending: true })
      .limit(CHUNK);
    if (cursor) q = q.gt("id", cursor);
    const { data, error } = await q;
    if (error) throw new Error(`subscriptions select failed: ${error.message}`);
    const subs = (data ?? []) as SubRow[];
    if (!subs.length) break;
    cursor = subs[subs.length - 1].id;

    for (const s of subs) {
      tally.scanned++;
      const { data: cev, error: cErr } = await admin
        .from("customer_events")
        .select("created_at")
        .in("event_type", ["subscription.cancelled", "portal.subscription.cancelled"])
        .eq("properties->>subscription_id", s.id)
        .order("created_at", { ascending: false })
        .limit(1);
      if (cErr) throw new Error(`cancel events read failed: ${cErr.message}`);
      let migratedAsCancelledAt: string | null = null;
      let appstleCancelEventAt: string | null = null;
      if (!cev?.length && s.migrated_from_contract_id) {
        const { data: mev } = await admin
          .from("customer_events")
          .select("created_at, properties")
          .eq("event_type", "subscription.migrated")
          .eq("properties->>subscription_id", s.id)
          .order("created_at", { ascending: true })
          .limit(1);
        const m = mev?.[0] as { created_at: string; properties: Record<string, unknown> } | undefined;
        if (m && m.properties?.status === "cancelled") migratedAsCancelledAt = m.created_at;
        if (migratedAsCancelledAt) {
          const { data: aev, error: aErr } = await admin
            .from("customer_events")
            .select("created_at")
            .eq("source", "appstle")
            .eq("event_type", "subscription.cancelled")
            .eq("properties->>shopify_contract_id", s.migrated_from_contract_id)
            .lte("created_at", migratedAsCancelledAt)
            .order("created_at", { ascending: false })
            .limit(1);
          if (aErr) throw new Error(`appstle cancel events read failed: ${aErr.message}`);
          appstleCancelEventAt = (aev?.[0]?.created_at as string | undefined) ?? null;
        }
      }
      const pick = pickCancelledAt({ cancelEventAt: (cev?.[0]?.created_at as string | undefined) ?? null, migratedAsCancelledAt, appstleCancelEventAt });
      if (!pick) { tally.no_evidence++; continue; }
      tally[pick.source]++;
      if (!APPLY) continue;
      const { data: upd, error: uErr } = await admin
        .from("subscriptions")
        .update({ cancelled_at: pick.at })
        .eq("id", s.id)
        .eq("workspace_id", s.workspace_id)
        .eq("status", "cancelled")
        .is("cancelled_at", null)
        .select("id");
      if (uErr) throw new Error(`update ${s.id} failed: ${uErr.message}`);
      if (upd?.length) tally.written++;
      else tally.raced++;
    }
  }
  console.log(`result: ${JSON.stringify(tally)}${APPLY ? "" : " (dry-run — nothing written)"}`);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error("ERR", errText(e));
    process.exit(1);
  });
}
