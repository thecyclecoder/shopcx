/**
 * Compat shim for the migrate-ad-hoc-kill-switches-to-resolver spec Phase 1 — a thin union that
 * wraps every existing ad-hoc kill-switch check so BOTH sources stay authoritative during the
 * migration. On or off from either side wins the OFF answer; only if both sources agree ON does
 * the gate stay open.
 *
 *   readEffectiveOnOff(nodeId, legacyFn) → { off, offBy?, source? }
 *
 * The legacy fn returns the pre-existing per-gate boolean (true = on, false = off, undefined =
 * absent ⇒ treated as ON — the default the ad-hoc columns already fail-open with when the row /
 * column is missing). The resolver call reads
 * [[./kill-switch-resolver]] `resolveEffectiveSwitch(nodeId)` — walks the canonical node registry
 * parent→parent up to the department seat.
 *
 * Union semantics:
 *   - `legacyFn()` returns `false` → OFF (attributed to `source='legacy'`).
 *   - `resolveEffectiveSwitch(nodeId).off === true` → OFF (attributed to the offending ancestor).
 *   - Otherwise → ON.
 *
 * If BOTH sources return OFF, the LEGACY reason wins (returned first) — the pre-migration
 * behaviour was already "the ad-hoc column pauses this gate", so surfacing that first keeps the
 * audit / log lines interpretable during the migration window. The resolver still binds; a caller
 * flipping the legacy column back ON without also clearing the resolver would still see OFF via
 * the resolver.
 *
 * Fail-open. A THROWN legacy fn or a resolver error degrades to ON — mirrors the ad-hoc columns'
 * own "column absent ⇒ enabled" and the resolver's "missing row ⇒ ON" fail-safes. An unavailable
 * signal never silently switches every gate off.
 *
 * The shim is imported by:
 *   - [[../github-pr-resolve]] `isAutoMergeEnabled` — auto-merge for the build-console workspace
 *   - [[../spec-test-runs]] `isAutoFoldEnabled` — auto-fold shipped specs
 *   - [[../media-buyer/arming-gate]] `runMediaBuyerArmingGate` — Media-Buyer arming readiness
 *   - [[../meta/execution]] `isMetaExecutionAdapterEnabled` — the ENABLED_ADAPTERS decision-engine gate
 *   - [[../meta/recommendation-execute]] `isMetaRecommendationAdapterEnabled` — the ENABLED_ADAPTERS recommendation-executor gate
 *   - [[../ads/voice-angle-approve]] `executeApproveVoiceAngle` — the voice-angle executor
 *
 * Phase 2 replaces each ad-hoc column with a resolver-only read; the shim's polarity contract
 * remains, so a Phase-2 caller that drops the legacy fn still sees the same OFF/ON answer.
 */
import { resolveEffectiveSwitch, type EffectiveSwitch } from "@/lib/control-tower/kill-switch-resolver";

/**
 * Test seam — a resolver override injected by unit tests to feed a fixture map without hitting
 * Supabase. Production callers leave this null; the shim then delegates to
 * [[./kill-switch-resolver]] `resolveEffectiveSwitch` (which uses the module-level TTL cache).
 * The seam is a test-only affordance — do not use from production callers.
 */
type ResolverFn = (nodeId: string) => Promise<EffectiveSwitch>;
let resolverOverride: ResolverFn | null = null;

/** Test-only: inject a resolver fixture. Pass `null` to restore the real DB-backed resolver. */
export function _setResolverForTests(fn: ResolverFn | null): void {
  resolverOverride = fn;
}

/** The source that caused the OFF verdict — surfaced so a caller can log the attribution. */
export type EffectiveOnOffSource = "legacy" | "resolver";

/** The verdict returned by `readEffectiveOnOff`. Fail-open: `off:false` when both sources are ON
 * or when either signal throws / is absent. */
export type EffectiveOnOff =
  | { off: false }
  | { off: true; source: EffectiveOnOffSource; offBy?: string; reason?: string | null };

/**
 * Union-semantics compat check: OFF if EITHER the legacy fn returns `false` OR
 * `resolveEffectiveSwitch(nodeId).off` is true. The legacy branch is evaluated first so its
 * attribution wins when both sources flip.
 *
 * A `legacyFn` return of `true` or `undefined` is treated as ON on the legacy side. A THROWN
 * `legacyFn` and a THROWN resolver call both degrade to ON — the fail-open default that mirrors
 * the ad-hoc columns' own "column absent ⇒ enabled" contract.
 */
export async function readEffectiveOnOff(
  nodeId: string,
  legacyFn: () => Promise<boolean | undefined>,
): Promise<EffectiveOnOff> {
  let legacy: boolean | undefined;
  try {
    legacy = await legacyFn();
  } catch {
    legacy = undefined; // fail-open on legacy read failure
  }
  if (legacy === false) {
    return { off: true, source: "legacy" };
  }
  let resolved: EffectiveSwitch;
  try {
    resolved = await (resolverOverride ?? resolveEffectiveSwitch)(nodeId);
  } catch {
    return { off: false }; // fail-open on resolver read failure
  }
  if (resolved.off) {
    return { off: true, source: "resolver", offBy: resolved.offBy, reason: resolved.reason };
  }
  return { off: false };
}

/**
 * Convenience wrapper for the common "should this gate stay ENABLED" question — collapses the
 * union verdict to a boolean. `true` = enabled (on); `false` = paused (off from either source).
 * Callers that need the attribution (audit logs / CEO card) use `readEffectiveOnOff` directly.
 */
export async function isEffectivelyEnabled(
  nodeId: string,
  legacyFn: () => Promise<boolean | undefined>,
): Promise<boolean> {
  const v = await readEffectiveOnOff(nodeId, legacyFn);
  return !v.off;
}
