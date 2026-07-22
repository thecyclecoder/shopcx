/**
 * Classify a Meta Graph error thrown from the final `createAd` boundary as a
 * "target ad set is unavailable" (deleted, archived, or the token no longer has
 * permission) — a PERMANENT publish target problem, not a transient wobble.
 *
 * The publisher (`src/lib/inngest/ad-tool.ts`) uses this at the `createAd`
 * catch to fail the publish job closed with a stable `meta_adset_unavailable`
 * reason and return normally, instead of rethrowing and turning a permanent
 * config problem into a `/api/inngest` exception that pages Control Tower.
 * Other unexpected errors still throw so real infra regressions surface.
 *
 * Meta shape (from `graphError` in [[../meta/graph-retry]]):
 *   err.metaCode / err.metaSubcode / err.httpStatus, plus a canonical message
 *   `meta_<status>: <detail>`.
 * The canonical "Object does not exist, cannot be loaded due to missing
 * permission or does not support this operation" is HTTP 400 with subcode 33;
 * plain permission errors surface as code 200 / 803. A message-shape fallback
 * covers edge cases where Meta returns the same class without a surfaced
 * subcode (Graph sometimes drops it on batched adset lookups).
 */

export const STALE_ADSET_FAILURE_REASON = "meta_adset_unavailable";

export function isMetaAdsetUnavailableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    metaCode?: unknown;
    metaSubcode?: unknown;
    httpStatus?: unknown;
    message?: unknown;
  };
  const code = typeof e.metaCode === "number" ? e.metaCode : Number(e.metaCode);
  const subcode = typeof e.metaSubcode === "number" ? e.metaSubcode : Number(e.metaSubcode);
  const httpStatus = typeof e.httpStatus === "number" ? e.httpStatus : Number(e.httpStatus);
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";

  // Canonical "Object does not exist / no permission / doesn't support this action" — Graph subcode 33.
  if (subcode === 33) return true;
  // Explicit permission-denied codes for the ad-account/adset object.
  if (code === 200 || code === 803) return true;
  // Message-shape fallback (HTTP 400 only — a 5xx is transient and retried upstream).
  if (httpStatus === 400) {
    if (message.includes("does not exist")) return true;
    if (message.includes("cannot be loaded")) return true;
    if (message.includes("missing permission")) return true;
  }
  return false;
}
