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
}

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
 *   - { ok: true, resumed: false } on a fresh insert.
 *   - { ok: true, resumed: true, existing } when the row already exists AND its claimant matches
 *     — an Inngest step re-run after a partial write, safe to proceed.
 *   - { ok: false, existing } when a DIFFERENT claimant already holds the key — the caller MUST
 *     refuse the charge (either the other claimant is still in flight, or already succeeded /
 *     failed for this cycle).
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
  return { ok: false, existing };
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
    .select("id, workspace_id, subscription_id, cycle_key, status, amount_cents, claimant, source, transaction_id, order_id, claimed_at, resolved_at")
    .eq("subscription_id", subscription_id)
    .eq("cycle_key", cycle_key)
    .maybeSingle();
  return (data as CycleChargeRow | null) ?? null;
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
