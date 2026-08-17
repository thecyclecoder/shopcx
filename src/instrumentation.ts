/**
 * Next.js 16 instrumentation hook — the in-process replacement for the deleted
 * Vercel-log-drain sink. Fires on every server error with the real error object and
 * request context, so there is nothing to parse out of log text and no HTTP round-trip
 * back into our own domain (the drain was self-feeding: it POSTed to
 * `https://shopcx.ai/api/webhooks/vercel-logs`, and each delivery's own lambda logs were
 * drained again — $1,850/mo, 433.6M edge requests in Aug 2026).
 *
 * We report through the SAME `recordError` chokepoint the drain sink used, on the SAME
 * `source: 'vercel'` value, so the Control Tower "Vercel errors" panel, signature
 * grouping, rate-limited paging and repair fan-out keep working with ZERO downstream
 * changes.
 *
 * Scope note (honest narrowing vs the drain): this hook sees errors from OUR code with
 * a request context. Platform-level events with no request context — a hard Runtime
 * Timeout, an OOM kill — do NOT route through it; those stay visible in Vercel's own
 * observability UI. That is a real, accepted narrowing versus the drain.
 *
 * See docs/brain/integrations/vercel-log-drain.md · docs/brain/specs/replace-log-drain-with-in-process-onrequesterror.md.
 */
import type { Instrumentation } from "next";
import { errText } from "@/lib/error-text";
import {
  recordError,
  isAbortedStreamNoise,
  isBareInngestStepErrorMiddlewareLog,
  isBareLifecycle,
  isForeignAppstleUnskipUpstream500,
  isForeignBraintreeVaultGatewayRejection,
  isForeignBraintreeVaultProcessorDecline,
  isForeignEasyPostReturnsSweepRateLimit,
  isInngestStepWrappedNonErrorLog,
  isInngestTerminalFailureMirrorLog,
  isTransientAnthropicOverloadError,
  isTransientAppstleFrequencyUpstreamTimeout,
  isTransientInngestStepRetryThrow,
  isTransientKlaviyoReviewsFetch5xx,
  isTransientShopifyWebhookHmacFailure,
  isTransientSupabaseEdgeHandshakeError,
  isTransientSupabaseEdgeHtmlBody,
  isTransientUndiciHeadersTimeout,
} from "@/lib/control-tower/error-feed";

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  // HARD REQUIREMENT: an error reporter that throws inside a failing request turns one
  // broken request into two, and the failure mode is invisible. Swallow everything.
  try {
    const name = err instanceof Error ? err.name : "Error";
    // errText is the shared lossless renderer — a supabase-js PostgREST error is a plain
    // object, and a bare `String(err)` would render it as `[object Object]` and destroy
    // the code/details/hint (enforced by scripts/_check-no-lossy-error-stringify.ts).
    const message = errText(err);
    const digest = err && typeof err === "object" && "digest" in err ? (err as { digest?: unknown }).digest : undefined;

    const path = request.path;
    const method = request.method;

    // The same noise / non-actionable / foreign-upstream classes the drain sink dropped
    // outright — we drop them here too so classification does not regress just because
    // the transport changed. Order mirrors the drain's `isError` filter.
    if (isBareLifecycle(message)) return;
    if (isAbortedStreamNoise(message, 0)) return;
    if (isBareInngestStepErrorMiddlewareLog(message, path)) return;
    if (isInngestStepWrappedNonErrorLog(message, path)) return;
    if (isInngestTerminalFailureMirrorLog(message, path)) return;
    if (isForeignAppstleUnskipUpstream500(path, message)) return;
    if (isForeignBraintreeVaultProcessorDecline(path, message)) return;
    if (isForeignBraintreeVaultGatewayRejection(path, message)) return;

    // The same transient classes the drain sink flagged. A transient first-sight is
    // recorded + grouped for visibility but NOT paged; only a recurrence inside the
    // window escalates. Keeps one-off deploy-boundary blips out of the pager while a
    // chronic always-failing function still surfaces.
    const transient =
      isTransientInngestStepRetryThrow(path, message) ||
      isTransientShopifyWebhookHmacFailure(path, message) ||
      isTransientAppstleFrequencyUpstreamTimeout(path, message) ||
      isTransientKlaviyoReviewsFetch5xx(path, message) ||
      isForeignEasyPostReturnsSweepRateLimit(path, message) ||
      isTransientSupabaseEdgeHandshakeError(message) ||
      isTransientSupabaseEdgeHtmlBody(message) ||
      isTransientUndiciHeadersTimeout(message) ||
      isTransientAnthropicOverloadError(message);

    await recordError({
      source: "vercel",
      // Stable bits — matches how the drain sink grouped (path + error class).
      keyParts: [path, name],
      title: `${name} ${path}`.slice(0, 300),
      detail: message,
      sample: {
        path,
        method,
        routerKind: context.routerKind,
        routeType: context.routeType,
        digest: digest ?? null,
      },
      transient,
    });
  } catch (reporterErr) {
    // Best-effort: swallow. Log to stderr so the failure is at least visible in Vercel's
    // observability UI even though we can't record it into error_events.
    console.warn("[instrumentation/onRequestError] reporter failed:", reporterErr);
  }
};
