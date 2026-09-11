/**
 * subscription-cycle-charge-claim — SDK for the per-(subscription, billing cycle) idempotency
 * ledger backing `public.subscription_cycle_charges`.
 *
 * Phase 1 of docs/brain/specs/immediate-charge-renewal-paths-need-per-subscription-idempotency.md.
 *
 * The chokepoint every immediate-charge caller for an internal sub funnels through is
 * `internal-subscription/renewal-attempt`. This SDK gates that handler:
 *
 *   1. `cycleKeyFromNextBillingDate(sub.next_billing_date)` — pure, YYYY-MM-DD.
 *   2. `claimCycleCharge({ workspace_id, subscription_id, cycle_key, claimant, ... })` — INSERTs
 *      a row with status='in_flight'. On unique-violation (23505), reads the existing row and
 *      returns { ok: false, existing }. Same-claimant hit (e.g. Inngest step re-runs after a
 *      transient failure post-INSERT) is treated as a resumed claim, not a duplicate.
 *   3. Charge → `resolveCycleCharge(id, { status, transaction_id?, order_id? })` marks the row
 *      terminal.
 *
 * The unique index on (subscription_id, cycle_key) is the actual guard — the SDK just converts
 * the constraint into a typed refusal instead of an exception. See the migration for the
 * lifecycle discussion (`in_flight` / `succeeded` / `failed`).
 *
 * Every write goes through the caller's service-role client (createAdminClient in the handler).
 * Per CLAUDE.md — the table is deny-all under RLS, never client-side.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

type Admin = SupabaseClient;

export type CycleChargeStatus = "in_flight" | "succeeded" | "failed";

export interface SupersededClaim {
  claimant: string;
  status: CycleChargeStatus;
  source: string | null;
  transaction_id: string | null;
  order_id: string | null;
  claimed_at: string;
  resolved_at: string | null;
  superseded_at: string;
  superseded_reason: "failed" | "stale_in_flight";
}

export interface CycleChargeRow {
  id: string;
  workspace_id: string;
  subscription_id: string;
  cycle_key: string;
  status: CycleChargeStatus;
  amount_cents: number | null;
  claimant: string;
  source: string | null;
  transaction_id: string | null;
  order_id: string | null;
  claimed_at: string;
  resolved_at: string | null;
  superseded_claims: SupersededClaim[];
}

/**
 * How long an `in_flight` row can sit unresolved before a new claimant is allowed to take it
 * over. A Braintree sale + the surrounding Inngest step normally settles in seconds; ten
 * minutes is far past any realistic completion, so a row still `in_flight` beyond it must be
 * from a crashed / stranded attempt. Making the number explicit lets it be reviewed rather
 * than buried; nudge it if a caller ever legitimately holds a claim longer.
 */
export const STALE_IN_FLIGHT_RECLAIM_MS = 10 * 60 * 1000;

export interface ClaimInput {
  workspace_id: string;
  subscription_id: string;
  cycle_key: string;
  claimant: string;
  amount_cents?: number | null;
  source?: string | null;
}

export type ClaimResult =
  | { ok: true; id: string; resumed: false }
  | { ok: true; id: string; resumed: true; existing: CycleChargeRow }
  | { ok: false; existing: CycleChargeRow };

/**
 * Pure: derive the cycle_key from the sub's pre-charge next_billing_date. YYYY-MM-DD so a
 * concurrent trigger that reads the same live date pins to the same key regardless of the
 * hh:mm:ss the handler stamps. Falls back to `unknown-cycle` when the date is unusable — the
 * caller MUST short-circuit those rather than claim, because a garbage key would collide across
 * unrelated retries.
 */
export function cycleKeyFromNextBillingDate(nextBillingDate: string | null | undefined): string {
  if (!nextBillingDate) return "unknown-cycle";
  const d = new Date(nextBillingDate);
  if (!Number.isFinite(d.getTime())) return "unknown-cycle";
  return d.toISOString().slice(0, 10);
}

/**
 * Try to claim (subscription_id, cycle_key). Returns:
 *   - { ok: true, resumed: false } on a fresh insert OR after atomically re-owning an existing
 *     `status='failed'` row (no Braintree sale occurred for that claim, so the cycle must remain
 *     re-claimable — see the wedge case in
 *     [[../specs/failed-cycle-charge-claim-must-not-wedge-order-now-and-renewal-retries]]) OR a
 *     stale `in_flight` row whose original claimant appears to have crashed
 *     (`STALE_IN_FLIGHT_RECLAIM_MS` past its `claimed_at`).
 *   - { ok: true, resumed: true, existing } when the row already exists AND its claimant matches
 *     — an Inngest step re-run after a partial write, safe to proceed.
 *   - { ok: false, existing } when a DIFFERENT claimant already holds the key AND its status is
 *     `in_flight` (still fresh) or `succeeded` — the caller MUST refuse (either the other
 *     claimant is still running, or a real charge already resolved for this cycle).
 *
 * Neither a `status='failed'` row NOR a stale `in_flight` row is a permanent block: no money
 * moved for the failed path, and a stale `in_flight` is a crashed attempt (a wedge shaped like
 * the failed case). Both trigger the compare-and-set reset below and PREPEND the prior claim to
 * `superseded_claims` so a repeatedly-declining subscription stays visible as such rather than
 * silently overwritten.
 *
 * Errors from the DB other than the 23505 unique violation propagate — a service failure while
 * claiming should NOT be silently treated as "safe to charge".
 */
export async function claimCycleCharge(
  admin: Admin,
  input: ClaimInput,
): Promise<ClaimResult> {
  const row = {
    workspace_id: input.workspace_id,
    subscription_id: input.subscription_id,
    cycle_key: input.cycle_key,
    status: "in_flight" as const,
    amount_cents: input.amount_cents ?? null,
    claimant: input.claimant,
    source: input.source ?? null,
  };

  const { data, error } = await admin
    .from("subscription_cycle_charges")
    .insert(row)
    .select("id")
    .single();

  if (!error && data) {
    return { ok: true, id: (data as { id: string }).id, resumed: false };
  }

  // Only a unique-violation on (subscription_id, cycle_key) becomes a refusal. Anything else is
  // a genuine failure the caller must surface.
  if (!error || (error as { code?: string }).code !== "23505") {
    throw new Error(
      `claim_cycle_charge_insert_failed: ${error?.message ?? "unknown"} ` +
        `(sub=${input.subscription_id} cycle=${input.cycle_key})`,
    );
  }

  const existing = await readCycleCharge(admin, input.subscription_id, input.cycle_key);
  if (!existing) {
    // The unique constraint fired but we couldn't find the offending row — a race where the
    // other claimant rolled back? Refuse conservatively; the caller emits a skip and we don't
    // double-charge.
    throw new Error(
      `claim_cycle_charge_conflict_but_row_not_found: sub=${input.subscription_id} cycle=${input.cycle_key}`,
    );
  }
  if (existing.claimant === input.claimant) {
    return { ok: true, id: existing.id, resumed: true, existing };
  }

  const reclaim = isReclaimable(existing);
  if (reclaim) {
    // Atomically reset+re-own the row so the new caller (portal order-now, the next renewal
    // cron, etc.) can proceed. Compare-and-set on the exact prior status AND the prior
    // `claimed_at` — a concurrent thread that already reset OR that JUST landed a fresh charge
    // stops us here (the CAS loses); the caller then falls through to the normal refusal via
    // the re-read.
    const priorSnapshot = supersedeSnapshot(existing, reclaim.reason);
    const nextSuperseded: SupersededClaim[] = [priorSnapshot, ...existing.superseded_claims];
    const reset = await admin
      .from("subscription_cycle_charges")
      .update({
        status: "in_flight",
        claimant: input.claimant,
        amount_cents: input.amount_cents ?? null,
        source: input.source ?? null,
        transaction_id: null,
        order_id: null,
        resolved_at: null,
        claimed_at: new Date().toISOString(),
        superseded_claims: nextSuperseded,
      })
      .eq("id", existing.id)
      .eq("status", existing.status)
      .eq("claimed_at", existing.claimed_at)
      .select("id");
    if (!reset.error && Array.isArray(reset.data) && reset.data.length > 0) {
      return { ok: true, id: existing.id, resumed: false };
    }
    if (reset.error) {
      throw new Error(
        `claim_cycle_charge_reset_reclaimable_row_failed: ${reset.error.message} ` +
          `(sub=${input.subscription_id} cycle=${input.cycle_key} row=${existing.id} ` +
          `reason=${reclaim.reason})`,
      );
    }
    // The CAS lost — the row moved between our SELECT and UPDATE. Re-read and route through
    // the normal same-claimant / refuse branches. A row that is NOW reclaimable again is left
    // for the caller's next attempt (rather than looping here) — the refusal is the safe answer
    // in a race.
    const nextExisting = await readCycleCharge(admin, input.subscription_id, input.cycle_key);
    if (!nextExisting) {
      throw new Error(
        `claim_cycle_charge_reset_race_row_not_found: sub=${input.subscription_id} cycle=${input.cycle_key}`,
      );
    }
    if (nextExisting.claimant === input.claimant) {
      return { ok: true, id: nextExisting.id, resumed: true, existing: nextExisting };
    }
    return { ok: false, existing: nextExisting };
  }
  return { ok: false, existing };
}

/**
 * A prior claim is reclaimable when no money-moving action can be in progress against it:
 * either it already DECLINED (no Braintree sale seated) or it is a stranded `in_flight` past
 * `STALE_IN_FLIGHT_RECLAIM_MS` (a crashed attempt would wedge the cycle indistinguishably from
 * a failed one). Anything fresher stays refusable — a concurrent attempt may still land.
 */
export function isReclaimable(
  existing: Pick<CycleChargeRow, "status" | "claimed_at">,
  now: number = Date.now(),
): { reason: "failed" | "stale_in_flight" } | null {
  if (existing.status === "failed") return { reason: "failed" };
  if (existing.status === "in_flight") {
    const claimedAtMs = new Date(existing.claimed_at).getTime();
    if (Number.isFinite(claimedAtMs) && now - claimedAtMs > STALE_IN_FLIGHT_RECLAIM_MS) {
      return { reason: "stale_in_flight" };
    }
  }
  return null;
}

function supersedeSnapshot(
  prior: CycleChargeRow,
  reason: "failed" | "stale_in_flight",
): SupersededClaim {
  return {
    claimant: prior.claimant,
    status: prior.status,
    source: prior.source,
    transaction_id: prior.transaction_id,
    order_id: prior.order_id,
    claimed_at: prior.claimed_at,
    resolved_at: prior.resolved_at,
    superseded_at: new Date().toISOString(),
    superseded_reason: reason,
  };
}

/**
 * Look up the current claim row for (subscription_id, cycle_key). Read-only helper used inside
 * `claimCycleCharge` on the 23505 branch and available to callers for diagnostics.
 */
export async function readCycleCharge(
  admin: Admin,
  subscription_id: string,
  cycle_key: string,
): Promise<CycleChargeRow | null> {
  const { data } = await admin
    .from("subscription_cycle_charges")
    .select("id, workspace_id, subscription_id, cycle_key, status, amount_cents, claimant, source, transaction_id, order_id, claimed_at, resolved_at, superseded_claims")
    .eq("subscription_id", subscription_id)
    .eq("cycle_key", cycle_key)
    .maybeSingle();
  if (!data) return null;
  const row = data as CycleChargeRow;
  // `superseded_claims` is a jsonb column with a NOT NULL DEFAULT of []; PostgREST returns it
  // as a real array, but pin the type here so a caller doing `existing.superseded_claims.length`
  // never trips over an unexpected null in a pre-migration read.
  return {
    ...row,
    superseded_claims: Array.isArray(row.superseded_claims) ? row.superseded_claims : [],
  };
}

export interface ResolveInput {
  status: "succeeded" | "failed";
  transaction_id?: string | null;
  order_id?: string | null;
  amount_cents?: number | null;
}

/**
 * Stamp the terminal status on a claim row. Compare-and-set on `status='in_flight'` so a stale
 * duplicate cannot overwrite a real outcome. A row that is no longer in_flight (already resolved
 * by a concurrent step, or never claimed by us) is left alone; the return signals whether the
 * update actually landed.
 */
export async function resolveCycleCharge(
  admin: Admin,
  id: string,
  input: ResolveInput,
): Promise<{ updated: boolean }> {
  const update: Record<string, unknown> = {
    status: input.status,
    resolved_at: new Date().toISOString(),
  };
  if (input.transaction_id !== undefined) update.transaction_id = input.transaction_id;
  if (input.order_id !== undefined) update.order_id = input.order_id;
  if (input.amount_cents !== undefined) update.amount_cents = input.amount_cents;

  const { data, error } = await admin
    .from("subscription_cycle_charges")
    .update(update)
    .eq("id", id)
    .eq("status", "in_flight")
    .select("id");

  if (error) {
    throw new Error(`resolve_cycle_charge_failed: ${error.message} (id=${id})`);
  }
  return { updated: Array.isArray(data) && data.length > 0 };
}

// ─── chargeIdempotency aliases ─────────────────────────────────────
// The concept this SDK enforces is a per-(subscription, cycle) *charge idempotency* guard —
// two triggers for the same cycle produce exactly one charge. The primary functions are named
// after the underlying `subscription_cycle_charges` table, but the SEMANTIC name is
// `chargeIdempotency` and every caller should reach for that. Aliases (not wrappers) so a rename
// stays cheap and callers get a stable identity.
//
// [[../inngest/internal-subscription-renewals]] uses `claimChargeIdempotency` / `resolveChargeIdempotency`
// at the pre-Braintree-sale chokepoint. Any future immediate-charge caller for an internal sub
// should reach for these names first — they read as intent rather than storage.

/** Alias for `claimCycleCharge` — the per-(subscription, cycle) charge idempotency claim. */
export const claimChargeIdempotency = claimCycleCharge;

/** Alias for `resolveCycleCharge` — stamps the terminal outcome on a charge idempotency claim. */
export const resolveChargeIdempotency = resolveCycleCharge;

/** Alias for `readCycleCharge` — read-only lookup of a live charge idempotency row. */
export const readChargeIdempotency = readCycleCharge;

/** Alias for `cycleKeyFromNextBillingDate` — the pure cycle_key derivation used to key a charge
 *  idempotency claim. */
export const chargeIdempotencyKeyFromNextBillingDate = cycleKeyFromNextBillingDate;
