/**
 * box-serial-claim-cooldown-wedge-guard Phase 1 — live-DB verifier for the
 * `public.claim_agent_job(text[])` cooldown contract.
 *
 * The box's build/plan claim loop RELIES on the RPC skipping a queued row whose
 * `claimed_at` is a FUTURE "hold-until" instant — that's how a gate-held build
 * backs off without churning the poll loop. The predicate lives in
 * supabase/migrations/20260727170000_durable_vale_review_passed_and_claim_cooldown.sql
 * (and is preserved by the kill-switch rewrite in
 *  supabase/migrations/20261014000000_kill_switch_enforce_claim.sql):
 *
 *   and (claimed_at is null or claimed_at <= now())
 *
 * If a hand-run migration or a manual DDL drift removes that predicate, a
 * gate-released row is immediately re-claimable, and the poll loop wedges on
 * that row forever WITHOUT ever writing its own heartbeat — the Control Tower
 * box tile then correctly reports the worker stale, but the operator has no
 * clean recovery signal ("worker is silent" instead of "claim RPC contract
 * broken").
 *
 * This helper reads the LIVE function body via `pg_get_functiondef` and asserts
 * the cooldown predicate is present. The box worker calls it BEFORE the
 * build/plan claim loop each poll pass (throttled with an internal TTL) and,
 * on a failed check, gates the loop with a `needs_attention` worker heartbeat
 * carrying the exact predicate-missing reason.
 *
 * Fail-open on pool-unavailable: if the shared pg pool has no credentials or the
 * `pg_get_functiondef` call errors, we return `ok:true` with a "cannot verify"
 * reason. The verifier is defensive; failing CLOSED on a pool blip would strand
 * every build behind a phantom needs_attention.
 *
 * Brain: docs/brain/libraries/claim-rpc-verify.md (co-committed with the code).
 */
import { pgQuery } from "./pg-pool";
import { errText } from "@/lib/error-text";

export interface ClaimCooldownVerification {
  /** true = live RPC honors the cooldown predicate (or we couldn't verify and are failing open). */
  ok: boolean;
  /** Human-legible; safe to surface on the worker heartbeat's `detail` field. */
  reason: string;
  /** true when the DB was probed AND the predicate check ran (ok reflects the live contract). */
  probed: boolean;
  /** Excerpt of the live function body when the predicate is missing — for operator diagnosis. */
  functionSource?: string;
}

// Matches either `(claimed_at is null or claimed_at <= now())` or the same
// expression without parens, in any whitespace/case.
const COOLDOWN_PREDICATE_RX = /claimed_at\s+is\s+null\s+or\s+claimed_at\s*<=\s*now\s*\(\s*\)/;

/** Pure predicate — checks a `pg_get_functiondef` string for the cooldown clause.
 *  Kept separate from the async wrapper so a unit test can pin the exact grammar
 *  without a live DB. */
export function checkClaimAgentJobCooldownPredicate(functionSource: string | null | undefined): ClaimCooldownVerification {
  if (!functionSource) {
    return {
      ok: false,
      probed: true,
      reason:
        "public.claim_agent_job(text[]) is not defined in the live DB — the box's claim contract is missing",
    };
  }
  const normalized = functionSource.replace(/\s+/g, " ").toLowerCase();
  if (COOLDOWN_PREDICATE_RX.test(normalized)) {
    return {
      ok: true,
      probed: true,
      reason:
        "live claim_agent_job(text[]) honors the (claimed_at is null or claimed_at <= now()) cooldown predicate",
    };
  }
  return {
    ok: false,
    probed: true,
    reason:
      "public.claim_agent_job(text[]) is missing the (claimed_at is null or claimed_at <= now()) cooldown predicate — a released build with a future claimed_at will be re-claimed immediately, wedging the poll loop",
    functionSource: functionSource.slice(0, 4000),
  };
}

/** Read the live `claim_agent_job(text[])` function body and check for the cooldown predicate.
 *  Fail-open on pool-unavailable / query error so a transient pool blip never falsely halts
 *  the box (the next tick re-checks). */
export async function verifyClaimAgentJobCooldown(): Promise<ClaimCooldownVerification> {
  let rows: Array<{ def: string | null }> | null;
  try {
    rows = await pgQuery<{ def: string | null }>(
      `SELECT pg_get_functiondef('public.claim_agent_job(text[])'::regprocedure) AS def`,
    );
  } catch (e) {
    return {
      ok: true,
      probed: false,
      reason: `pg-pool query threw while verifying claim_agent_job cooldown (failing open): ${
        errText(e)
      }`,
    };
  }
  if (rows === null) {
    return {
      ok: true,
      probed: false,
      reason: "pg-pool unavailable — cannot verify claim_agent_job cooldown (failing open for this tick)",
    };
  }
  const def = rows[0]?.def ?? null;
  return checkClaimAgentJobCooldownPredicate(def);
}
