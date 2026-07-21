/**
 * Control Tower — error feed (error-feed-monitoring spec, Phase 1).
 *
 * The capture + page + snapshot layer for the three "hidden surfaces" where
 * failures used to go unseen:
 *   - inngest  — a function that failed after exhausting retries (the
 *                inngest/function.failed handler calls recordError).
 *   - vercel   — a prod runtime error / 500 delivered by a Vercel Log Drain
 *                (/api/webhooks/vercel-logs calls recordError per grouped batch).
 *   - supabase — a non-null Supabase { error } our own code saw (reportDbError) —
 *                the swallowed-error class, caught at the source.
 *
 * Errors are GROUPED by (source, signature): a burst of the same error folds into
 * ONE error_events incident (count++, last_seen_at bumped), not N rows / N pages.
 * The owners are paged on a NEW signature or a re-firing SPIKE, rate-limited to one
 * page per incident per PAGE_COOLDOWN_MS — so 500 of the same 500 = one page.
 *
 * Everything here is BEST-EFFORT and never throws: an error-reporter that can crash
 * the path it's reporting on is worse than the gap it closes.
 *
 * See docs/brain/specs/error-feed-monitoring.md · docs/brain/tables/error_events.md.
 */
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifyOpsAlert } from "@/lib/notify-ops-alert";
import { enqueueRepairJob } from "@/lib/repair-agent";
import { isClaudeBreakerTripped } from "@/lib/claude-health";

type Admin = ReturnType<typeof createAdminClient>;

export type ErrorSource = "inngest" | "vercel" | "supabase" | "supabase-logs" | "client";

/** Page at most once per incident per this window — a burst = one page (rate-limit). */
const PAGE_COOLDOWN_MS = 30 * 60_000;

const SOURCE_LABEL: Record<ErrorSource, string> = {
  inngest: "Inngest failure",
  vercel: "Vercel error",
  supabase: "Supabase error",
  // The Management Logs feed (Phase 2): DB-level errors our app never saw.
  "supabase-logs": "Supabase DB-log error",
  // The fourth feed (client-error-capture): browser JS errors on storefront + portal.
  client: "Client error",
};

/**
 * Normalize an error string into a stable grouping key: lowercase, then strip the
 * volatile bits (uuids, long hex, numbers, quoted ids) so "row 4821 not found" and
 * "row 9173 not found" collapse to ONE signature. A short sha1 of the result.
 */
function normalizeForSignature(parts: string[]): string {
  const joined = parts.filter(Boolean).join(" | ").toLowerCase();
  const stripped = joined
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/0x[0-9a-f]+/g, "<hex>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hex>")
    .replace(/\b\d[\d,.]*\b/g, "<n>")
    .replace(/["'`].*?["'`]/g, "<str>")
    .replace(/\s+/g, " ")
    .trim();
  return crypto.createHash("sha1").update(stripped).digest("hex").slice(0, 16);
}

/** Build the (source, signature) grouping key for an error. `keyParts` should be the
 *  STABLE bits (function id, route, error class) — not run-specific ids. */
export function signatureFor(source: ErrorSource, keyParts: string[]): string {
  return `${source}:${normalizeForSignature(keyParts)}`;
}

/**
 * Node.js Web-Streams client-abort teardown noise — the companion to vercel-logs'
 * `isBareLifecycle`, factored here so any feed can reuse it ([[../specs/error-feed-drop-aborted-stream-noise]]).
 *
 * When a visitor aborts an SSR stream mid-flight (client disconnect, `status:0` —
 * the response never completed), Node core's Web-Streams teardown can race and emit a
 * `level:'error'` log with NO frame in our code — the documented TransformStream race
 * (nodejs/node#62040) surfaced by Next.js streaming. It is non-actionable framework
 * noise with no fix in our code; minting an open incident for it pages owners on a
 * healthy PDP (Control Tower `vercel:801aa4e3922198d3`). We drop it before grouping.
 *
 * Gated tightly so it only ever swallows this signature: requires ALL of
 *   1. `status === 0` (the aborted-stream marker — the response never completed),
 *   2. a message naming a member of the Web-Streams abort/teardown family, AND
 *   3. a stack whose every `at …` frame is an ignore-listed (framework/internal) frame —
 *      i.e. zero frames in our code. A real error with a frame in our code is kept.
 */
export function isAbortedStreamNoise(message: string, status: number): boolean {
  if (status !== 0) return false;
  const text = (message ?? "").trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  const matchesAbortFamily =
    lower.includes("transformalgorithm is not a function") ||
    lower.includes("invalid state: controller is already closed") ||
    lower.includes("err_stream_premature_close") ||
    /(^|[^a-z])aborted([^a-z]|$)/.test(lower);
  if (!matchesAbortFamily) return false;
  // Every stack frame must be an ignore-listed frame (Node collapses framework/internal
  // frames to "at ignore-listed frames"). No `at …` frame ⇒ not this signature; keep it.
  const atFrames = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^at\s/i.test(l));
  if (atFrames.length === 0) return false;
  return atFrames.every((l) => /^at\s+ignore-listed frames\b/i.test(l));
}

/**
 * A Vercel/Lambda log whose entire body is request-lifecycle scaffolding —
 * `START`/`END`/`REPORT RequestId` blocks (+ their Duration/Memory metric lines) and
 * the bare `[METHOD] path status=NNN` proxy summary — carries NO error body. For a 5xx
 * it is the non-actionable platform wrapper around a failure the function already logged
 * itself (a `console.error` with its own stable signature + repair spec). Recording it
 * too mints a SECOND, redundant signature for one failure (Control Tower
 * `vercel:ebdf493a37c60c34`), so we drop these before signature-grouping. A lifecycle
 * block that ALSO carries a real message/stack (e.g. "Task timed out", an uncaught
 * exception) is NOT bare and is still captured.
 *
 * Note the proxy-summary matcher is intentionally NOT `$`-anchored after `status=NNN`:
 * the real Vercel proxy line carries trailing tokens (duration, region, byte counts)
 * after the status, e.g. `[POST] /api/portal?route=removeLineItem status=502 669ms`.
 * The original `$`-anchored regex never matched that line, so `.every()` failed and the
 * wrapper was captured — the false-positive that opened `vercel:ebdf493a37c60c34`.
 */
export function isBareLifecycle(message: string): boolean {
  const lines = (message ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(
    (l) =>
      /^START RequestId:/i.test(l) ||
      /^END RequestId:/i.test(l) ||
      /^REPORT RequestId:/i.test(l) ||
      // REPORT continuation / metric lines when Lambda splits them onto their own lines.
      /^(Duration|Billed Duration|Memory Size|Max Memory Used|Init Duration|Restore Duration):/i.test(l) ||
      // XRAY/Segment trailers Lambda sometimes appends to a REPORT block.
      /^(XRAY TraceId|SegmentId|Sampled|Status):/i.test(l) ||
      // The bare proxy summary line: "[POST] /api/portal?route=x status=502 [trailing…]".
      // Tolerate trailing tokens after status=NNN (duration/region/bytes) — no `$` anchor.
      /^\[[A-Z]+\]\s+\S+\s+status=\d{3}\b/i.test(l),
  );
}

/**
 * Inngest's built-in `LoggerMiddleware` bare-label log lines — drop before signature
 * grouping ([[../specs/error-feed-drop-bare-inngest-step-error-middleware-log]] +
 * [[../specs/error-feed-drop-bare-inngest-function-error-middleware-log]]).
 *
 * The Inngest SDK's `LoggerMiddleware` emits the same `{ err }, <label>` pattern in two
 * places: `onStepError` (`'Inngest step error'`, every step throw — transient + final)
 * and `wrapFunctionHandler` (`'Inngest function error'`, every function-handler
 * rejection). The actual error object lives in the JSON `err` context — Vercel's drain
 * serializes only the bare Pino `msg` field, so what reaches us is the literal label
 * with no error body. Terminal failures are already authoritatively captured on
 * `source='inngest'` by inngest-failure-capture.ts (triggers on
 * `inngest/function.failed`), so the bare middleware logs on `/api/inngest` are
 * duplicate noise on a healthy retry loop — minting a fresh OPEN incident for either
 * pages Platform owners on a function that already self-heals (Control Tower
 * `vercel:b1daa612f563f5e9` for the step label, `vercel:dcc421bdd0ffd0a5` for the
 * function label).
 *
 * `true` ONLY for path `/api/inngest` + a message whose trimmed body equals one of the
 * two exact bare labels. A log with the same label but additional body (a real
 * stack/detail Vercel managed to surface) is NOT bare and is still captured.
 */
const BARE_INNGEST_MIDDLEWARE_LABELS = new Set(["Inngest step error", "Inngest function error"]);

export function isBareInngestStepErrorMiddlewareLog(
  message: string,
  path: string | null | undefined,
): boolean {
  if (path !== "/api/inngest") return false;
  return BARE_INNGEST_MIDDLEWARE_LABELS.has((message ?? "").trim());
}

/**
 * Inngest step-wrapped non-Error log noise — the stack-form sibling to
 * `isBareInngestStepErrorMiddlewareLog`, factored here so the vercel-logs route can reuse
 * it ([[../specs/error-feed-drop-inngest-step-wrapped-non-error-noise]]).
 *
 * When an Inngest step handler throws a non-Error value (e.g. `throw {foo: 'bar'}` or any
 * plain object), the Inngest SDK's `buildStepErrorOp` wraps it as
 * `new Error(String(error))` — and `String({…})` is the literal `[object Object]`. Pino's
 * `LoggerMiddleware.onStepError` logs the wrapped Error; Vercel's log drain surfaces the
 * wrapped Error's STACK, which has zero application frames because the wrapping happened
 * inside the SDK (only compiled Inngest chunk frames like `M.buildStepErrorOp` /
 * `M.tryExecuteStep` / `steps-found` / `M._start`). The result is a brand-new signature
 * `vercel:d48a64ae867f66dd` titled `ERR /api/inngest: Error: [object Object]` that opened
 * a fresh incident and paged Platform owners on a step whose true terminal failure — if
 * it ever exhausts retries — is already captured on `source='inngest'` by
 * [[../inngest/inngest-failure-capture]] with the real function id + error class. So the
 * Vercel log is duplicate noise on a healthy self-healing loop.
 *
 * `true` ONLY when ALL of:
 *   1. `path === '/api/inngest'` (the Inngest webhook route),
 *   2. the trimmed message begins with `Error: [object Object]`,
 *   3. the stack contains a `buildStepErrorOp` frame (the SDK's wrapping site), AND
 *   4. NO `at …` frame names a file under `src/` or `app/` (i.e. the entire stack is
 *      inside Inngest SDK chunks with zero application frames — a real application throw
 *      that happens to carry the same literal string ships a stack with a frame in our
 *      code and stays captured).
 *
 * The existing `isBareInngestStepErrorMiddlewareLog` only catches the literal Pino label
 * `"Inngest step error"`; this stack-form variant surfaces as the wrapped Error message
 * with SDK-only frames, which that filter doesn't match.
 */
export function isInngestStepWrappedNonErrorLog(
  message: string,
  path: string | null | undefined,
): boolean {
  if (path !== "/api/inngest") return false;
  const text = (message ?? "").trim();
  if (!text) return false;
  if (!text.startsWith("Error: [object Object]")) return false;
  if (!text.includes("buildStepErrorOp")) return false;
  // Every `at …` frame must be inside the compiled Inngest SDK chunk — zero frames in
  // our code (`src/` or `app/`). A real application throw carrying the same literal
  // message ships a stack with a frame in our code and stays captured.
  const atFrames = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^at\s/i.test(l));
  if (atFrames.length === 0) return false;
  return !atFrames.some((l) => l.includes("src/") || l.includes("app/"));
}

/**
 * Inngest FUNCTION-LEVEL terminal-failure mirror stack — the /api/inngest log the SDK's
 * `LoggerMiddleware.wrapFunctionHandler` emits (`{ err }, 'Inngest function error'`) when
 * a function's final retry throws. Vercel's drain surfaces the label PLUS the wrapped
 * `err` (message + stack), so this variant slips past `isBareInngestStepErrorMiddlewareLog`
 * (bare label only) and `isInngestStepWrappedNonErrorLog` (SDK-only stack, no app frame).
 * The terminal failure is already authoritatively captured on `source='inngest'` by
 * [[../inngest/inngest-failure-capture]] with the real function id + error class + trigger
 * event — minting a second Control Tower incident from the Vercel mirror pages Platform
 * owners on ONE upstream wobble as if it were two independent problems and sends repair
 * work down the less-informative Vercel path (Control Tower `vercel:6d4f3f4eee64afcf` —
 * the meta_500 mirror of `shopcx-media-buyer-test-cadence`'s terminal failure).
 *
 * `true` ONLY when ALL of:
 *   1. `path === '/api/inngest'` (the Inngest webhook route),
 *   2. the message includes the exact SDK label `Inngest function error`,
 *   3. the message includes an `Error:` marker (the serialized wrapped `err.message` — the
 *      variant that carries a real body, not the bare label already dropped upstream),
 *   4. the stack contains the SDK's `wrapFunctionHandler` frame (the terminal-catch site
 *      — distinguishes function-level exhaustion from step-level `buildStepErrorOp`), AND
 *   5. the stack contains at least one frame in OUR Inngest source (`src/lib/inngest/` or
 *      `app/api/inngest/`) — proves the mirror maps to one of our functions that ALREADY
 *      has the authoritative `source='inngest'` capture with the real function id.
 *
 * A non-Inngest /api/inngest error (e.g. middleware throw outside `wrapFunctionHandler`),
 * an unrelated Vercel runtime error on a different path, or an Inngest log missing any of
 * the five markers stays captured / paged on first sighting.
 */
export function isInngestTerminalFailureMirrorLog(
  message: string,
  path: string | null | undefined,
): boolean {
  if (path !== "/api/inngest") return false;
  const text = (message ?? "").trim();
  if (!text) return false;
  if (!text.includes("Inngest function error")) return false;
  if (!text.includes("wrapFunctionHandler")) return false;
  if (!/(^|\s)Error:/.test(text)) return false;
  return text.includes("src/lib/inngest/") || text.includes("app/api/inngest/");
}

/**
 * Inngest TRANSPORT-layer failure noise — the inngest companion to `isBareLifecycle` /
 * `isAbortedStreamNoise`, factored here so the capture path can reuse it
 * ([[../specs/error-feed-drop-inngest-transport-http-unreachable]]).
 *
 * `inngest/function.failed` fires for BOTH application throws and Inngest's own
 * transport-layer failures — the `http_unreachable` class, where Inngest couldn't get a
 * clean reply from our Vercel SDK URL (the deployment reset the connection mid-reply, an
 * "Unexpected ending response"). That's a deploy-boundary Lambda reap / momentary
 * connection reset against an every-15-min cron, NOT an application bug — the function body never
 * threw and the next beat recovers. Minting a fresh OPEN incident for it pages Platform
 * owners on a loop that already healed (Control Tower `inngest:06e8cf82e141fbaa`).
 *
 * `true` when the error name OR message names a member of the transport-failure family.
 * NOTE this only CLASSIFIES the noise — the capture path uses it as the `transient` flag
 * to `recordError`, which auto-resolves a FIRST sighting (recorded, not paged) and only
 * escalates to a real open+page if the SAME signature recurs within the recur window —
 * so a genuine chronic timeout (function always failing) still surfaces.
 */
export function isTransientInngestTransportError(
  errName: string | null | undefined,
  errMessage: string | null | undefined,
): boolean {
  const text = `${errName ?? ""} ${errMessage ?? ""}`.toLowerCase();
  if (!text.trim()) return false;
  return (
    text.includes("http_unreachable") ||
    text.includes("performing request to sdk url") ||
    text.includes("reset the connection") ||
    text.includes("unexpected ending response")
  );
}

/**
 * Inngest STEP-RETRY noise — when an Inngest `step.run` intentionally throws to trigger
 * its own retry (the companion to `isTransientInngestTransportError`, but on the Vercel
 * log-drain side — the throw IS the retry mechanism so it surfaces as an `/api/inngest`
 * error log even though the function body never finally-failed).
 *
 * Example: `socialPublish` detects a transient Meta Graph failure and throws so Inngest
 * re-runs the step with backoff (`throw new Error('transient publish failure (attempt 1/5): …')`).
 * Attempt 1/5 means 4 attempts remain; the function body has not finally-failed and the
 * existing `mark-publishing`+`finalize` bracket means no row is stuck. Minting a fresh
 * OPEN incident for it pages Platform owners on a loop that already self-heals
 * (Control Tower `vercel:0ffd0e07c0fe9336`).
 *
 * `true` when the log is from `/api/inngest` AND the message carries an `(attempt N/M)`
 * marker with `N < M` — i.e. retries remain. The N==M final-attempt throw IS the terminal
 * failure (the step ran out of retries) and stays captured / paged.
 *
 * NOTE this only CLASSIFIES — `/api/webhooks/vercel-logs` passes the result as the
 * `transient` flag to `recordError`, which auto-resolves a FIRST sighting (recorded for
 * visibility, NOT paged, no repair fan-out) and only escalates to a real open+page if the
 * SAME signature recurs within `TRANSIENT_RECUR_WINDOW_MS` (chronic → still broken). So a
 * one-off blip is dropped while a function that throws on every retry still surfaces.
 */
export function isTransientInngestStepRetryThrow(
  path: string | null | undefined,
  message: string | null | undefined,
): boolean {
  const p = (path ?? "").trim().toLowerCase();
  if (!p.startsWith("/api/inngest")) return false;
  const text = (message ?? "").trim();
  if (!text) return false;
  // `(attempt N/M)` — the convention a step-retry throw uses to surface its current
  // attempt index and the configured total. N<M ⇒ retries remain (non-final throw).
  const m = text.match(/\(attempt\s+(\d+)\s*\/\s*(\d+)\)/i);
  if (!m) return false;
  const attempt = Number(m[1]);
  const total = Number(m[2]);
  if (!Number.isFinite(attempt) || !Number.isFinite(total) || total <= 0) return false;
  return attempt < total;
}

/**
 * Shopify webhook HMAC-failure noise — the shopify companion to
 * `isTransientInngestStepRetryThrow`, factored here so the vercel-logs route can reuse it
 * ([[../specs/error-feed-shopify-webhook-hmac-transient]]).
 *
 * `/api/webhooks/shopify` + `/api/webhooks/shopify-returns` reject a request whose HMAC
 * doesn't verify with a 401 and a `console.error("Shopify webhook HMAC failed …")` /
 * `console.error("Shopify returns webhook HMAC failed …")`. A SINGLE such log is almost
 * never an integration bug — it's a one-off probe (Shopify's own wiring check, a scanner,
 * a stale-secret retry from a deleted-then-recreated webhook subscription) that the next
 * legitimate delivery clears. Minting a fresh OPEN incident on first sighting pages
 * Platform owners on a healthy webhook loop (Control Tower `vercel:fc64a1540851bf79`).
 *
 * `true` ONLY when the log is from one of the shopify webhook routes AND the message
 * begins with the exact HMAC-failure prefix. Wired in `/api/webhooks/vercel-logs` as the
 * `transient` flag to `recordError`, which auto-resolves a first sighting (recorded for
 * visibility, NOT paged, no repair fan-out) and escalates to a real open+page ONLY if
 * the SAME signature recurs within `TRANSIENT_RECUR_WINDOW_MS` — so a one-off probe is
 * dropped while a chronic signing bug (would recur every beat) still surfaces.
 *
 * Unrelated errors on the same routes (a JSON parse failure, a downstream throw) carry
 * different messages and stay captured / paged on first sighting.
 */
export function isTransientShopifyWebhookHmacFailure(
  path: string | null | undefined,
  message: string | null | undefined,
): boolean {
  const p = (path ?? "").trim().toLowerCase();
  if (p !== "/api/webhooks/shopify" && p !== "/api/webhooks/shopify-returns") return false;
  const text = (message ?? "").trim();
  if (!text) return false;
  return (
    text.startsWith("Shopify webhook HMAC failed") ||
    text.startsWith("Shopify returns webhook HMAC failed")
  );
}

/**
 * Appstle frequency-update upstream-timeout noise — the appstle sibling to
 * `isTransientInngestTransportError` / `isTransientShopifyWebhookHmacFailure`, factored here
 * so the vercel-logs route can reuse it
 * ([[../specs/vercel-appstle-frequency-upstream-timeout-transient-classifi]]).
 *
 * `src/lib/appstle.ts` `updateBillingInterval` fetches Appstle's
 * `subscription-contracts-update-billing-interval` endpoint through `loggedAppstleFetch`,
 * whose 20-second abort deadline fires as `throw new Error('upstream_timeout')`. The outer
 * catch logs `console.error("Appstle frequency update failed:", err)` and then RECOVERS the
 * same way the explicit `res.status === 504` branch does — it re-fetches the contract via
 * `verifyBillingInterval` and, if the interval matches, treats the timeout as a successful
 * apply (Appstle applied the change but the response never returned inside 20s). So the
 * log-drain line is a PRE-RECOVERY sighting of a dependency stall the code already knows
 * how to handle; the customer-facing flow either landed or was safely verified after.
 * Minting a fresh OPEN paged incident + repair fan-out for it churns Platform owners on a
 * loop that already self-heals (Control Tower `vercel:cec725132e1eef09`).
 *
 * `true` ONLY when ALL of:
 *   1. `path` is on the small allowlist of surfaces that call `updateBillingInterval` —
 *      currently `/api/inngest` (the durable Inngest step) and `/api/portal` (the
 *      customer portal frequency route), which share the exact same helper + 20s abort
 *      + `verifyBillingInterval` recovery, so their timeout lines are the same
 *      pre-recovery sighting (Control Tower `vercel:63b8e91c77459378`),
 *   2. the trimmed message begins with the exact `Appstle frequency update failed` prefix
 *      (the catch's console.error label — not any other Appstle failure log), AND
 *   3. the message carries the `Error: upstream_timeout` marker (the 20s abort's error).
 *
 * A non-timeout Appstle failure (a 4xx/5xx from Appstle carrying a different error class,
 * a JSON parse throw, a downstream helper throw) carries a different marker and stays
 * captured / paged on first sighting, regardless of which allowlisted path it fired from.
 * Wired in `/api/webhooks/vercel-logs` as the `transient` flag to `recordError`, which
 * auto-resolves a first sighting (recorded for visibility, NOT paged, no repair fan-out)
 * and escalates to a real open+page ONLY if the SAME signature recurs within
 * `TRANSIENT_RECUR_WINDOW_MS` — so a one-off Appstle stall is dropped while a chronic
 * Appstle outage (would recur every beat) still surfaces.
 */
const APPSTLE_FREQUENCY_UPDATE_PATHS: ReadonlySet<string> = new Set([
  "/api/inngest",
  "/api/portal",
]);

export function isTransientAppstleFrequencyUpstreamTimeout(
  path: string | null | undefined,
  message: string | null | undefined,
): boolean {
  if (!path || !APPSTLE_FREQUENCY_UPDATE_PATHS.has(path)) return false;
  const text = (message ?? "").trim();
  if (!text) return false;
  if (!text.startsWith("Appstle frequency update failed")) return false;
  return text.includes("Error: upstream_timeout");
}

/**
 * Foreign-app noise — Appstle's `unskip-order` endpoint returning an Internal Server
 * Error to the dunning recovery path ([[../specs/error-feed-scope-appstle-unskip-upstream-500-noise]]).
 *
 * `src/lib/appstle.ts` `appstleUnskipOrder` calls Appstle's
 * `subscription-billing-attempts/unskip-order/<id>` endpoint through
 * `loggedAppstleFetch` for the dunning-cycle payday-retry path
 * (`src/lib/inngest/dunning.ts` → `subscriptionUnskipOrder`). When Appstle's own
 * service 500s on that call, the wrapper's non-ok branch logs
 * `console.error(\`Appstle unskip order error for ${id}:\`, text)` and RETURNS a
 * structured `{ success: false, error }` — the dunning step then continues its
 * recovery sequence (switch card, retry billing) with the failure result. So the
 * log-drain line is a sighting of a vendor-owned upstream 500 the code already
 * handles cleanly; minting a fresh OPEN paged incident + repair fan-out for it
 * churns Platform owners on a foreign surface we hold no levers on (Control Tower
 * `vercel:5959f3e309a7800c`).
 *
 * `true` ONLY when ALL of:
 *   1. `path` equals `/api/inngest` — the Inngest dunning recovery function is the
 *      only surface that reaches `appstleUnskipOrder` today; a different caller
 *      would fire on a different path and stays captured / paged,
 *   2. the trimmed message begins with the exact `Appstle unskip order error for `
 *      prefix (the wrapper's console.error label — not any other Appstle log), AND
 *   3. the message carries the `Internal Server Error` marker (Appstle's 500 body).
 *
 * A non-500 Appstle unskip failure (a 4xx from Appstle, a different body class), a
 * throw from `loggedAppstleFetch` itself (which logs `Appstle unskip order failed:`
 * with the caught `err`), or any other Appstle log carries a different marker /
 * prefix and stays captured. Wired in `/api/webhooks/vercel-logs` as the
 * `transient` flag to `recordError`, which auto-resolves a first sighting
 * (recorded for visibility, NOT paged, no repair fan-out) and escalates to a real
 * open+page ONLY if the SAME signature recurs within `TRANSIENT_RECUR_WINDOW_MS`
 * — so a one-off Appstle 500 is dropped while a chronic Appstle outage (would
 * recur every beat) still surfaces.
 */
export function isForeignAppstleUnskipUpstream500(
  path: string | null | undefined,
  message: string | null | undefined,
): boolean {
  if (path !== "/api/inngest") return false;
  const text = (message ?? "").trim();
  if (!text) return false;
  if (!text.startsWith("Appstle unskip order error for ")) return false;
  return text.includes("Internal Server Error");
}

/**
 * Foreign-app noise — EasyPost's account-level rate limit surfacing on the
 * returns-reconcile-sweep's `lookupTracking` call
 * ([[../specs/error-feed-scope-easypost-returns-sweep-rate-limit-noise]]).
 *
 * `src/lib/inngest/returns-reconcile-sweep.ts` calls `lookupTracking` (which
 * hits EasyPost's `/trackers` endpoint) for each in-flight return; when
 * EasyPost's account-level throttle kicks in the client throws with the exact
 * `... temporarily rate-limited due to excessive resource consumption` body,
 * and the sweep's catch branch logs
 * `console.error(\`[returns-reconcile-sweep] lookupTracking failed for return ${id} (tracking ${n}):\`, err)`
 * and `return`s from the per-row worker — the row is skipped and re-picked on
 * the next daily sweep, no state to repair on our side. So a burst of ~39 of
 * these in ~15 seconds (Control Tower `vercel:53af50d6c3a578ec`) is a foreign
 * vendor's throttle hitting a code path that already self-heals; minting a
 * fresh OPEN paged incident + repair fan-out for it churns Platform owners on
 * a surface we hold no levers on (EasyPost's own error text says to contact
 * their Support if it recurs).
 *
 * `true` ONLY when ALL of:
 *   1. `path` equals `/api/inngest` — the returns-reconcile-sweep Inngest
 *      function is the only surface that reaches this call site today; a
 *      different caller would fire on a different path and stays captured /
 *      paged,
 *   2. the trimmed message begins with the exact
 *      `[returns-reconcile-sweep] lookupTracking failed for return ` prefix
 *      (the sweep's own console.error label — not any other EasyPost log), AND
 *   3. the message carries the `temporarily rate-limited` marker (EasyPost's
 *      account-level throttle body).
 *
 * A different `lookupTracking` failure on the same sweep — a bad tracking
 * number, a genuine EasyPost outage carrying a different body class, a throw
 * from our own client — carries a different marker and stays captured /
 * paged. Wired in `/api/webhooks/vercel-logs` as the `transient` flag to
 * `recordError`, which auto-resolves a first sighting (recorded for
 * visibility, NOT paged, no repair fan-out) and escalates to a real open+page
 * ONLY if the SAME signature recurs within `TRANSIENT_RECUR_WINDOW_MS` — so a
 * one-off EasyPost throttle burst is dropped while a chronic EasyPost outage
 * (would recur every daily sweep) still surfaces.
 */
export function isForeignEasyPostReturnsSweepRateLimit(
  path: string | null | undefined,
  message: string | null | undefined,
): boolean {
  if (path !== "/api/inngest") return false;
  const text = (message ?? "").trim();
  if (!text) return false;
  if (!text.startsWith("[returns-reconcile-sweep] lookupTracking failed for return ")) return false;
  return text.includes("temporarily rate-limited");
}

/**
 * Browser network-abort TypeError noise — the CLIENT-feed companion to
 * `isTransientInngestTransportError` / `isTransientShopifyWebhookHmacFailure`, factored
 * here so `/api/client-errors` can reuse it
 * ([[../specs/error-feed-drop-safari-load-failed-client-network-abort-noise]]).
 *
 * Every browser has a fixed TypeError message it throws when a `fetch()` is CANCELLED or
 * the network drops mid-flight — Safari 'Load failed', Chrome/Firefox 'Failed to fetch' /
 * 'NetworkError when attempting to fetch resource', iOS URLSession 'The network
 * connection was lost', Chrome bare 'network error'. These are the browser counterpart to the Node stream-abort +
 * Inngest transport-reset noise the feed already tags as transient: the request never
 * completed (mobile tab backgrounded, signal lost mid-navigation, page unload aborted an
 * in-flight fetch), and the session recovers by itself. Minting a fresh OPEN incident
 * on a first sighting pages Platform owners on a healthy browser that already recovered
 * (Control Tower `client:fe00dcba3e396856`, one iPhone Safari 26.5 user on /dashboard/roadmap).
 *
 * `true` ONLY when BOTH: the message is EXACTLY one of the well-known network-abort
 * TypeErrors AND the stack is empty/null. A real code-throw carrying the same literal
 * string (e.g. `throw new TypeError('Load failed')` in our own code) would ship a stack
 * with a frame in our code and stays captured. Wired in `/api/client-errors` as the
 * `transient` flag to `recordError`, which auto-resolves a first sighting (recorded for
 * visibility, NOT paged, no repair fan-out) and escalates to a real open+page only if
 * the SAME signature recurs within `TRANSIENT_RECUR_WINDOW_MS` — so a one-off browser
 * hiccup is dropped while a burst from many browsers (chronic client outage) still
 * surfaces on recurrence.
 */
const CLIENT_NETWORK_ABORT_MESSAGES = new Set([
  "load failed",
  "failed to fetch",
  "networkerror when attempting to fetch resource",
  "networkerror when attempting to fetch resource.",
  "the network connection was lost",
  "the network connection was lost.",
  "network error",
  "network error.",
]);

export function isTransientClientNetworkAbort(
  message: string | null | undefined,
  stack: string | null | undefined,
): boolean {
  const text = (message ?? "").trim().toLowerCase();
  if (!text) return false;
  if (!CLIENT_NETWORK_ABORT_MESSAGES.has(text)) return false;
  // A real code-throw carrying the same literal string ships a stack; a browser
  // network-abort TypeError arrives with an empty/null stack from the reporter.
  const s = (stack ?? "").trim();
  return s === "";
}

/**
 * Transient Supabase-logs noise — the supabase-logs companion to `isBareLifecycle` /
 * `isTransientInngestTransportError`, factored here so the poller can reuse it
 * ([[../specs/error-feed-supabase-logs-transient-5xx-scoping]]).
 *
 * `pollSupabaseLogs` records EVERY edge API 5xx row and every Postgres ERROR/FATAL/PANIC.
 * But a momentary edge 5xx, or a Postgres `statement timeout` / connection-saturation row,
 * is the collateral of a brief DB-saturation/timeout storm that self-heals by the next
 * beat — NOT a chronic outage (e.g. this cluster's simultaneous transient 500s on
 * GET /rest/v1/loop_heartbeats + GET /rest/v1/customers). Minting a fresh OPEN paged
 * incident + a repair fan-out for it churns Platform owners on a blip that already healed.
 *
 * `true` for that transient class — the capture path passes it as the `transient` flag to
 * `recordError`, which auto-resolves a FIRST sighting (recorded for visibility, NOT paged,
 * no repair fan-out) and escalates to a real open+page ONLY if the SAME signature recurs
 * within `TRANSIENT_RECUR_WINDOW_MS` — so a one-off saturation blip is dropped while a
 * chronic endpoint that 5xxs every poll (recurs well inside the window) still surfaces.
 *
 * NOT transient (page on first sighting): a Postgres FATAL/PANIC, a non-timeout Postgres
 * ERROR (constraint / data-integrity bug), an auth error, and anything below 5xx.
 */
export function isTransientSupabaseLogNoise(
  kind: "postgres" | "auth" | "api",
  ctx: { statusCode?: unknown; severity?: unknown; message?: unknown; eventMessage?: unknown },
): boolean {
  if (kind === "api") {
    // Edge/gateway 5xx — saturation collateral; the recur window catches a chronic 5xx.
    const raw = typeof ctx.statusCode === "string" ? ctx.statusCode.trim() : ctx.statusCode;
    const status = Number(raw);
    return Number.isFinite(status) && status >= 500 && status <= 599;
  }
  if (kind === "postgres") {
    // FATAL/PANIC are crashes, never the self-healing transient class.
    const severity = String(ctx.severity ?? "").toUpperCase();
    if (severity === "FATAL" || severity === "PANIC") return false;
    // Only the statement-timeout / saturation noise; a plain ERROR (constraint, etc.) pages.
    const msg = String(ctx.message ?? "").toLowerCase();
    if (!msg.trim()) return false;
    return (
      msg.includes("statement timeout") ||
      msg.includes("canceling statement due to") ||
      msg.includes("connection reset") ||
      msg.includes("terminating connection") ||
      msg.includes("too many clients") ||
      msg.includes("the database system is") ||
      msg.includes("could not serialize access")
    );
  }
  if (kind === "auth") {
    // GoTrue logs `Unhandled server error: timeout: context canceled` (and the sibling
    // `context deadline exceeded`) when the CLIENT goes away mid-request — a signed-in
    // browser unmounting while supabase.auth.getUser() is in-flight. That's a healthy
    // browser-abort signal, not an auth failure; scope it into the transient class the
    // same way the postgres branch scopes `canceling statement due to` / `statement
    // timeout`. Anything else on auth (invalid JWT, rate limit, signature mismatch) still
    // pages on first sighting.
    //
    // The same browser-abort also surfaces as Go's `net.OpError` phrasing when the request
    // context dies MID-DIAL against the GoTrue → Postgres socket: `failed to connect to
    // host=... : dial error (dial tcp [::1]:5432: operation was canceled)`. Same class,
    // different phrase — allowlist `operation was canceled` and the general `dial ...
    // canceled` shape too.
    //
    // The TIMEOUT sibling of `dial ... canceled`: when GoTrue's dial timer fires before the
    // TCP handshake completes (as opposed to the parent context dying mid-dial), Go emits
    // `failed to connect to host=... : dial error (dial tcp <addr>: i/o timeout)`. Same
    // self-healing class as `canceled` — the upstream reachability already recovered by the
    // next beat, no user impact, just repair-loop churn on a healed blip
    // ([[../specs/error-feed-scope-supabase-auth-dial-io-timeout-transient]]) — allowlist
    // the `dial ... i/o timeout` shape too. Recur-window escalation still applies: a chronic
    // dial-timeout spike (a real upstream outage) recurs inside the window and pages.
    const msg = String(ctx.message ?? "").toLowerCase();
    // The same browser-abort marker ALSO surfaces on GoTrue's /authorize (PKCE flow-state)
    // path where the marker lives INSIDE event_message JSON's `error` field instead of the
    // top-level `msg` — msg is only `500: Error creating flow state` and the real cause
    // (`context canceled`, `operation was canceled`, etc.) is buried in the JSON blob
    // ([[../specs/error-feed-scope-supabase-authorize-flow-state-context-cance]] — Control
    // Tower signature `supabase-logs:a30ffe4489dd6ffb`). Defensively JSON-parse eventMessage
    // (bad JSON is a no-op — msg-only path still applies) and fold its inner `error` string
    // into the same regex/substring set below so a user closing the Google-login tab stops
    // minting page-worthy incidents. A real /authorize failure whose inner error is NOT a
    // browser-abort marker (e.g. `invalid JWT`, `signature mismatch`, non-abort 5xx) still
    // pages on first sighting.
    let innerError = "";
    if (typeof ctx.eventMessage === "string" && ctx.eventMessage.trim()) {
      try {
        const parsed: unknown = JSON.parse(ctx.eventMessage);
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          const err = (parsed as { error: unknown }).error;
          if (typeof err === "string") innerError = err.toLowerCase();
        }
      } catch {
        // Defensive: malformed / non-JSON event_message — no-op, fall back to msg-only.
      }
    }
    if (!msg.trim() && !innerError.trim()) return false;
    const isAbortShape = (s: string): boolean =>
      s.includes("context canceled") ||
      s.includes("context deadline exceeded") ||
      s.includes("operation was canceled") ||
      /\bdial\b[^\n]*\bcanceled\b/.test(s) ||
      /\bdial\b[^\n]*i\/o timeout/.test(s) ||
      // GoTrue's own gateway-timeout phrasing when the auth API can't return in time under
      // load: `504: Processing this request timed out, please retry after a moment.` Same
      // transient class as the context-deadline shape above (restore of the reverted
      // error-feed-scope-supabase-auth-504-gateway-timeout-transient — falsely rolled back
      // 2026-07-04). A one-off pages nobody; a chronic 504 spike (a real outage) recurs and
      // still surfaces. Invalid JWT / rate-limit / signature mismatch remain first-sight pages.
      s.includes("processing this request timed out");
    return isAbortShape(msg) || (innerError.length > 0 && isAbortShape(innerError));
  }
  return false;
}

/**
 * Foreign-app noise — Supabase's own GoTrue user endpoint returning 504 Gateway Timeout
 * on the edge_logs feed ([[../specs/error-feed-drop-supabase-gotrue-504-edge-noise]]).
 *
 * Supabase's GoTrue auth service intermittently 504s on its own `/auth/v1/user` under load
 * — an upstream infra saturation blip on Supabase's side. We do not run GoTrue and cannot
 * patch its gateway; we hold ZERO levers here. The prior fix scoped this into the transient
 * class ([[isTransientSupabaseLogNoise]] `kind:'auth'` `processing this request timed out`
 * branch — the AUTH log, not the API edge_log), but the same shape ALSO surfaces on
 * `edge_logs` as a `/auth/v1/user` + `504` row, and because Supabase's gateway saturates on
 * a cadence outside our control, the signature recurs inside `TRANSIENT_RECUR_WINDOW_MS`
 * and escalates on every cycle — a Platform owner paged in a loop they cannot fix.
 *
 * Same choice we already made for supabase-edge-ssl-handshake and undici-headers-timeout
 * noise: when the surface is foreign-owned and we hold no levers, DROP AT CAPTURE — do not
 * even record the row. Narrowly gated to the exact `/auth/v1/user` + `504` shape so a real
 * GoTrue outage on other paths, a 5xx that isn't 504, or a non-auth endpoint blip is still
 * captured normally.
 *
 * `true` iff `path === '/auth/v1/user'` AND `statusCode` coerces to 504. Consumed by the
 * `api` LogQuery's `mapRow` in [[./supabase-log-poll]] — the mapRow contract treats `null`
 * as `drop, do not record`, so returning null here fully suppresses the row (no error_event,
 * no loop_alert, no signature). Not a `transient` flag: this is a capture-time drop.
 */
export function isForeignGoTrueEdgeNoise(
  path: string | null | undefined,
  statusCode: unknown,
): boolean {
  if (path !== "/auth/v1/user") return false;
  const raw = typeof statusCode === "string" ? statusCode.trim() : statusCode;
  const status = Number(raw);
  return Number.isFinite(status) && status === 504;
}

/**
 * Foreign-app noise — Supabase's own GoTrue `/user` saturating on its Postgres backend,
 * arriving on the app-level auth_logs feed. The auth-log sibling of
 * [[isForeignGoTrueEdgeNoise]] (which drops the same blip on the Cloudflare edge_logs).
 * We do not run GoTrue and hold ZERO levers on its gateway; both shapes below are a healed
 * foreign-app blip a user never sees (a normal `supabase.auth.getUser()` just retries and
 * succeeds), so DROP AT CAPTURE — no error_event / loop_alert / signature / repair fan-out.
 * Consumed by the `auth` LogQuery's `mapRow` in [[./supabase-log-poll]] — the mapRow
 * contract treats `null` as `drop, do not record`, matching the `api` mapRow's edge-noise
 * drop. `eventMessage` is OPTIONAL: the context-deadline shape is msg-only (one call site
 * passes just the message), the 504 shape needs the request JSON.
 *
 * Five distinct GoTrue-saturation signatures, ANY of which drops (each surfaced as
 * transient before, but recurred inside `TRANSIENT_RECUR_WINDOW_MS` and paged a Platform
 * owner in a loop they can't fix):
 *
 *  (a) context-deadline ([[../specs/error-feed-drop-supabase-gotrue-auth-log-context-deadline-us]],
 *      `supabase-logs:9f39fe11dd105b2a`, 39 occ / 6 days) — the `/user` handler 504s waiting
 *      on its Postgres backend after ~14.8s and emits `level:'error'` with the EXACT phrase
 *      `Unhandled server error: context deadline exceeded` (case-insensitive, trimmed).
 *
 *  (b) 504 gateway-timeout ([[../specs/error-feed-drop-supabase-gotrue-504-auth-log-noise]],
 *      `supabase-logs:9d5fae2f5f92ec3d`, 46 occ / 7 days) — msg starts with
 *      `504: Processing this request timed out` AND the request JSON (`eventMessage`) carries
 *      BOTH `"path":"/user"` AND `"method":"GET"`.
 *
 *  (c) localhost dial-timeout ([[../specs/error-feed-drop-supabase-gotrue-auth-log-localhost-dial-time]],
 *      `supabase-logs:0ca9220a8f0d2405`, 7 occ / 9h) — GoTrue's `/user` handler can't reach
 *      its own local Postgres inside its dial timer and emits `Unhandled server error:
 *      failed to connect to \`host=localhost user=supabase_auth_admin database=postgres\`:
 *      dial error (dial tcp [::1]:5432: i/o timeout | operation was canceled)`. Msg starts
 *      with `Unhandled server error: failed to connect to` AND contains BOTH the
 *      `host=localhost` and `user=supabase_auth_admin` markers (the unambiguous GoTrue →
 *      its-own-Postgres shape — never OUR pooler, which is a remote host) AND a
 *      `dial ... (i/o timeout | operation was canceled)` phrase.
 *
 *  (d) `/user` SELECT-on-auth.users browser-abort passthrough
 *      ([[../specs/error-feed-drop-supabase-gotrue-auth-log-unable-to-fetch-rec]],
 *      `supabase-logs:f5b02a707c3d4e49`, 8 occ / 4 days) — when the parent HTTP request
 *      context dies mid-query on GoTrue's `/user` SELECT-on-`auth.users` path (browser tab
 *      closed, navigation away, React StrictMode double-mount aborting an in-flight
 *      `supabase.auth.getUser()`), GoTrue emits the EXACT phrase `Unhandled server error:
 *      unable to fetch records: context canceled` (case-insensitive, trimmed). Already
 *      routed through `isTransientSupabaseLogNoise` via the `context canceled` substring,
 *      but the signature recurs inside `TRANSIENT_RECUR_WINDOW_MS` on a healthy loop, so
 *      the transient class isn't enough — drop AT CAPTURE. The phrase is unique to
 *      GoTrue's SELECT-on-`auth.users` code path; nothing in OUR code can emit it.
 *
 *  (e) outer-request-timeout ([[../specs/error-feed-drop-supabase-gotrue-timeout-context-canceled]],
 *      `supabase-logs:c9eb05fd1d3fb82c`, 15 occ / 7 days) — msg-only mirror of shape (a):
 *      the trimmed + lowercased msg equals `unhandled server error: timeout: context canceled`.
 *      The `timeout:` prefix is Go's phrasing for GoTrue's own outer-request-timeout wrapper
 *      firing on its Postgres backend (same foreign-owned saturation class as (a); we hold
 *      zero levers on Supabase's managed auth service, and the transient recur-window
 *      empirically fails to absorb the ~2/day cadence). Narrowly gated to the exact phrase
 *      so plain `context canceled` (real browser-abort noise, still transient) is untouched.
 *
 * Narrowly gated so everything actionable still surfaces / pages on first sight: a plain
 * `context canceled` on a non-/user path (any msg other than the exact (d) or (e) phrase)
 * stays transient via `isTransientSupabaseLogNoise`; a `dial ... i/o timeout` /
 * `dial ... canceled` on a REMOTE host (a real Postgres pooler on our side — not the
 * `host=localhost user=supabase_auth_admin` GoTrue-internal shape) stays transient too;
 * `invalid JWT`, rate limits, signature mismatches, a 504 on `/token` / `/admin`, a
 * non-504 5xx, or a 504 on `/user` with a non-GET (mutation) method all carry different
 * shapes and stay captured.
 */
export function isForeignGoTrueAuthLogNoise(
  msg: string | null | undefined,
  eventMessage?: string | null | undefined,
): boolean {
  // (a) context-deadline shape — msg-only, exact phrase.
  const text = (msg ?? "").trim().toLowerCase();
  if (text === "unhandled server error: context deadline exceeded") return true;
  // (d) /user SELECT-on-auth.users browser-abort — msg-only, exact phrase.
  if (text === "unhandled server error: unable to fetch records: context canceled") return true;
  // (e) outer-request-timeout shape — msg-only mirror of (a), gated on the exact phrase
  // (the `timeout:` prefix is GoTrue's outer-timeout wrapper; plain `context canceled`
  // stays transient).
  if (text === "unhandled server error: timeout: context canceled") return true;
  // (b) 504 gateway-timeout shape — msg 504-prefix + request JSON path /user + method GET.
  const m = (msg ?? "").trimStart();
  if (m.startsWith("504: Processing this request timed out")) {
    const em = eventMessage ?? "";
    if (em.includes('"path":"/user"') && em.includes('"method":"GET"')) return true;
  }
  // (c) localhost dial-timeout shape — GoTrue → its own localhost Postgres, dial timer fires
  // before the TCP handshake completes (i/o timeout) or the parent context dies mid-dial
  // (operation was canceled). The `host=localhost` + `user=supabase_auth_admin` markers
  // together pin this to Supabase-internal dialing; a dial failure against OUR remote
  // Postgres pooler carries different host/user markers and is kept (still transient).
  const lower = m.toLowerCase();
  if (
    lower.startsWith("unhandled server error: failed to connect to") &&
    lower.includes("host=localhost") &&
    lower.includes("user=supabase_auth_admin") &&
    /\bdial\b[^\n]*(?:i\/o timeout|operation was canceled)/.test(lower)
  ) {
    return true;
  }
  return false;
}

/**
 * Transient Supabase-EDGE SSL-handshake noise — the app-layer sibling of
 * `isTransientSupabaseLogNoise` / `isTransientInngestTransportError`, factored here so any
 * feed can reuse it ([[../specs/error-feed-drop-supabase-edge-ssl-handshake-noise]]).
 *
 * When Supabase's Cloudflare edge can't complete an SSL handshake with the origin for a
 * brief window, its response body is Cloudflare's HTML `525: SSL handshake failed` error
 * page — not JSON. App-layer callers that best-effort-log the response body then emit that
 * full HTML blob as an `rpcErr.message` (the shortlink route's click-logging RPC — a
 * `console.error("[shortlink] counter increment failed:", rpcErr.message)` at
 * `src/app/api/sl/[slug]/route.ts:144`), which the Vercel log drain surfaces as an ERR
 * `/api/sl/[slug]` entry. The redirect flow itself is healthy (the catch is designed to
 * swallow this so the customer's redirect still ships), so minting a fresh OPEN paged
 * incident on a self-healed upstream blip churns Platform owners on a healthy loop
 * (Control Tower `vercel:be569a72ccfdbf14`).
 *
 * `true` ONLY when BOTH markers unique to this shape are present:
 *   1. a Cloudflare error-page fingerprint — the `no-js` + `oldie` <html> preamble, OR
 *      the `cf-error-details` class Cloudflare renders on its 5xx error pages,
 *   2. `supabase.co` (the host that owns the Cloudflare-fronted edge) AND a 5xx
 *      SSL/certificate marker — `525: SSL handshake failed`, `SSL handshake failed`,
 *      or `526: Invalid SSL certificate`.
 *
 * Wired in `/api/webhooks/vercel-logs` as the `transient` flag to `recordError`, which
 * auto-resolves a first sighting (recorded for visibility, NOT paged, no repair fan-out)
 * and escalates to a real open+page ONLY if the SAME signature recurs within
 * `TRANSIENT_RECUR_WINDOW_MS` — so a one-off edge blip is dropped while a chronic
 * upstream outage (would recur every beat) still surfaces.
 *
 * KEPT (not transient): a Cloudflare 525 page for a different host (unrelated upstream),
 * a real Supabase JSON error that happens to carry the words "SSL handshake" (no
 * Cloudflare fingerprint), and empty/nullish input.
 */
export function isTransientSupabaseEdgeHandshakeError(message: string | null | undefined): boolean {
  const text = (message ?? "").trim();
  if (!text) return false;
  const lower = text.toLowerCase();
  // Marker 1: a Cloudflare error-page fingerprint. The classic Cloudflare 5xx template
  // opens with a `<html class="no-js ie6 oldie">`-style preamble; newer pages embed a
  // `cf-error-details` block instead. Either is enough to identify the origin.
  const cloudflareFingerprint =
    (lower.includes("no-js") && lower.includes("oldie") && lower.includes("<title>")) ||
    lower.includes("cf-error-details");
  if (!cloudflareFingerprint) return false;
  // Marker 2: supabase.co is the host that owns the edge, AND the page names a 5xx
  // SSL/certificate failure. Both required so we don't swallow a Cloudflare 525 for a
  // different host (unrelated upstream outage).
  if (!lower.includes("supabase.co")) return false;
  return (
    lower.includes("525: ssl handshake failed") ||
    lower.includes("ssl handshake failed") ||
    lower.includes("526: invalid ssl certificate")
  );
}

/**
 * Undici outbound-fetch headers-timeout noise — the outbound-fetch companion to
 * `isTransientInngestTransportError` (Inngest transport reset) and
 * `isTransientSupabaseLogNoise` (Supabase edge 5xx / statement timeout), factored here so
 * the vercel-logs route can reuse it
 * ([[../specs/error-feed-drop-undici-headers-timeout-noise]] — falsely rolled back 2026-07-04,
 * restored here; NOT a mechanical revert since error-feed.ts moved on ·
 * [[../specs/error-feed-headers-timeout-classifier-match-bracketed-cause-]] — extended to
 * also accept the bracketed wrapped-error shape Node emits for `new Error('...', { cause })`).
 *
 * Node's undici HTTP client emits `TypeError: fetch failed` with cause
 * `HeadersTimeoutError` / `UND_ERR_HEADERS_TIMEOUT` when an outbound request our server made
 * started fine but the upstream never returned response headers before the network-level
 * timeout tripped — a momentary upstream network stall. Nothing in our code is broken; the
 * next batch to the same endpoint self-heals. Minting a fresh OPEN paged incident + repair
 * fan-out for a single such log churns Platform owners on a healthy loop that already
 * recovered.
 *
 * `true` when the message carries BOTH a fetch-failed marker AND a headers-timeout cause
 * marker, accepting the two wire shapes Node produces for this class:
 *
 *   - PLAIN (undici emits it directly):
 *       `TypeError: fetch failed` + `HeadersTimeoutError` / `UND_ERR_HEADERS_TIMEOUT`.
 *   - BRACKETED WRAPPED (Node's `util.inspect` on an outer Error wrapping the TypeError with
 *     `{ cause }` — the shape /api/inngest logs when an Inngest `step.run(...)` fetch trips):
 *       `[Error [TypeError]: fetch failed] { [cause]: Error: Headers Timeout Error }` —
 *     the `]` between `TypeError` and `:` breaks the plain substring, and the human-language
 *     `Headers Timeout Error` (three spaced words) is the underlying Error's `.message`, not
 *     the class-name `HeadersTimeoutError` or the code `UND_ERR_HEADERS_TIMEOUT`.
 *
 * A `fetch failed` from any other cause (DNS, TLS, our own code throwing a same-worded
 * TypeError) carries a different cause and stays paged on first sighting. Recurrence-gated
 * like its siblings: a chronic upstream outage still surfaces.
 */
export function isTransientUndiciHeadersTimeout(message: string | null | undefined): boolean {
  const text = (message ?? "").trim();
  if (!text) return false;
  const fetchFailed =
    text.includes("TypeError: fetch failed") || text.includes("[TypeError]: fetch failed");
  if (!fetchFailed) return false;
  return (
    text.includes("HeadersTimeoutError") ||
    text.includes("UND_ERR_HEADERS_TIMEOUT") ||
    text.includes("Headers Timeout Error")
  );
}

/**
 * Transient Supabase-edge Cloudflare 5xx HTML body noise — the vercel-drain sibling to
 * `isTransientUndiciHeadersTimeout` / `isTransientSupabaseLogNoise`, factored here so the
 * vercel-logs route can reuse it
 * ([[../specs/error-feed-drop-supabase-edge-html-body-noise-reland]] — re-land of PR #1115
 * after a false-positive Reva revert on 2026-07-04; this classifier is a pure text-matcher
 * on incoming Vercel-drain logs with zero runtime side-effect, so the 07/04 cron-freshness
 * signals Reva correlated with the deploy cannot have been causally caused by it — both the
 * stale crons and this classifier sit downstream of the same 07/04 Supabase edge outage).
 *
 * When Supabase's edge is momentarily unreachable, its Cloudflare tier returns a `521 Web
 * server is down` HTML error page instead of the usual JSON. supabase-js reports that back
 * as an error whose message IS the raw HTML body, and callers like
 * `computePlatformScorecard` throw with a message like
 * `platform_scorecard_snapshots upsert failed: ? <!DOCTYPE html>...supabase.co | 521: Web
 * server is`. The scorecard cron catches this and moves on, and the next daily beat
 * idempotently heals via the done-guard + `(workspace_id, metric_key, cadence,
 * snapshot_date)` upsert — nothing is broken. Minting a fresh OPEN paged incident + repair
 * fan-out for a single such log churns Platform owners on a healthy loop that already
 * recovered (Control Tower `vercel:a0844c1b5be72bb7` / `vercel:848a7b6d02c1e88c`).
 *
 * `true` ONLY when the message carries BOTH the `<!DOCTYPE html>` marker AND a Supabase-
 * edge-Cloudflare signature (`supabase.co` alongside a Cloudflare 5xx status word: `Web
 * server` / `521` / `522` / `523` / `524`) — the exact and only shape the Cloudflare edge
 * emits for this class. A supabase-js JSON error (`PostgrestError` / `code`/`hint`/`details`
 * payload) stays captured / paged; a bare `<!DOCTYPE html>` HTML-parse failure from an
 * unrelated upstream carries no `supabase.co` marker and stays captured / paged too.
 *
 * Wired in `/api/webhooks/vercel-logs` as the `transient` flag to `recordError`, which
 * auto-resolves a first sighting (recorded for visibility, NOT paged, no repair fan-out)
 * and escalates to a real open+page ONLY if the SAME signature recurs within
 * `TRANSIENT_RECUR_WINDOW_MS` — so a one-off edge blip is dropped while a chronic Supabase
 * outage (would recur every beat) still surfaces.
 */
export function isTransientSupabaseEdgeHtmlBody(message: string | null | undefined): boolean {
  const text = (message ?? "").trim();
  if (!text) return false;
  if (!text.includes("<!DOCTYPE html>")) return false;
  if (!text.includes("supabase.co")) return false;
  return (
    text.includes("Web server") ||
    text.includes("521") ||
    text.includes("522") ||
    text.includes("523") ||
    text.includes("524")
  );
}

/**
 * Transient Anthropic overload / 5xx leak noise — the vercel-drain sibling to
 * `isTransientSupabaseEdgeHtmlBody` / `isTransientUndiciHeadersTimeout`, factored here so the
 * vercel-logs route can reuse it
 * ([[../specs/error-feed-classify-anthropic-overload-5xx-transient]]).
 *
 * Anthropic 529 (Overloaded) — and 5xx more broadly — is a well-known transient upstream
 * ([[anthropic-retry]] `isRetryableAnthropicStatus`: 408/409/425/429/5xx incl. 529 are
 * retryable; the customer-facing path already retries under
 * `AnthropicDependencyError` with `OUTAGE_SPANNING_RETRIES`, and `claude-health` folds it
 * into the outage-aware breaker). Best-effort callers that catch-and-log the throw (e.g.
 * `src/lib/fraud-detector.ts` `[fraud] AI screen error:` around the AI screen fetch —
 * `throw new Error(`AI API error: ${aiRes.status}`)` at `fraud-detector.ts:704`, and the
 * `throw new Error(`Anthropic API error: ${response.status}`)` at
 * `src/lib/inngest/fraud-detection.ts:174`) surface the caught error to `console.error`,
 * which Vercel drains to `/api/webhooks/vercel-logs`. A single such 529 leak therefore mints
 * a fresh OPEN paged incident on a loop that already gracefully handled the failure — the
 * classic monitor-false-positive that the existing transient-classifier chain was built to
 * catch (Control Tower `vercel:ca4ae59dcd07707a`, and the sibling
 * `Anthropic API error: 5NN` widening from `vercel:752bb49488e5aa72`).
 *
 * `true` when the message carries an unambiguous Anthropic-5xx/overload marker:
 *   - `AI API error: 5NN` / `Anthropic API error: 5NN` — the two sibling caught-throw shapes
 *      (`src/lib/fraud-detector.ts:704` and `src/lib/inngest/fraud-detection.ts:174`,
 *      respectively), and any other caller that copies either pattern.
 *   - `Anthropic ... returned 5NN` — the `throwForAnthropicStatus` shape from
 *     [[anthropic-retry]], including the 529-overloaded case.
 *   - `AnthropicDependencyError` — the class name Node's `util.inspect` writes for a caught
 *     dependency-error throw ([[anthropic-retry]] `AnthropicDependencyError`).
 *   - `api.anthropic.com` alongside any 5xx or overloaded marker — direct raw-fetch 5xx text
 *     leaked from any caller that reports the upstream URL + status.
 *
 * A 4xx logic bug (`AI API error: 400` / `Anthropic ... returned 401`) stays captured / paged
 * on first sighting — those never succeed on retry, so they are terminal bugs to fix.
 * Recurrence-gated like its siblings: a chronic Anthropic outage would recur every beat and
 * still surface, and the outage-aware breaker in `recordError` already handles a flood
 * downstream of a known outage.
 *
 * Wired in `/api/webhooks/vercel-logs` as the `transient` flag to `recordError`, which
 * auto-resolves a first sighting (recorded for visibility, NOT paged, no repair fan-out)
 * and escalates to a real open+page ONLY if the SAME signature recurs within
 * `TRANSIENT_RECUR_WINDOW_MS`.
 */
export function isTransientAnthropicOverloadError(message: string | null | undefined): boolean {
  const text = (message ?? "").trim();
  if (!text) return false;

  // `AI API error: 5NN` / `Anthropic API error: 5NN` — the two sibling caught-throw shapes,
  // from `src/lib/fraud-detector.ts:704` and `src/lib/inngest/fraud-detection.ts:174`
  // respectively (and any other caller that copies either pattern). 529 is the specific
  // overload signal we care about; the full 5xx band is retryable per
  // `isRetryableAnthropicStatus`. The `Anthropic API error:` prefix was folded in for the
  // `fraud-generate-summary` false positive at Control Tower `vercel:752bb49488e5aa72`.
  if (/(?:AI|Anthropic) API error:\s*5\d{2}\b/.test(text)) return true;

  // `Anthropic ... returned 5NN` — the `throwForAnthropicStatus` shape from anthropic-retry
  // (e.g. "Anthropic messages returned 529").
  if (/Anthropic\b[^\n]*\breturned\s+5\d{2}\b/.test(text)) return true;

  // The dependency-error class name leaks via `util.inspect` on a caught throw.
  if (text.includes("AnthropicDependencyError")) return true;

  // Direct raw-fetch upstream 5xx / overload text — any caller that reports the upstream
  // URL + status. Guarded by `api.anthropic.com` so an unrelated 5xx isn't swept in.
  if (text.includes("api.anthropic.com")) {
    if (/\b5\d{2}\b/.test(text)) return true;
    if (/overloaded/i.test(text)) return true;
  }

  return false;
}

export interface RecordErrorInput {
  source: ErrorSource;
  /** the grouping key parts (stable bits — function id / route / error class). */
  keyParts: string[];
  /** short human-readable label for the panel. */
  title: string;
  /** the fuller / latest message. */
  detail?: string | null;
  /** the latest raw sample (function_id, run_id, path, code, …). */
  sample?: Record<string, unknown> | null;
  /** occurrences folded in this call (a pre-grouped Vercel batch may pass >1). */
  occurrences?: number;
  /** Transient class (e.g. a one-off Inngest transport reset — see
   *  `isTransientInngestTransportError`): a FIRST sighting is auto-resolved (recorded +
   *  grouped for visibility, NOT paged, no repair fan-out). It escalates to a real
   *  open+page ONLY if the SAME signature recurs within `TRANSIENT_RECUR_WINDOW_MS` — so a
   *  one-off deploy-boundary blip is dropped while a chronic always-failing function still
   *  surfaces. A stale prior sighting (beyond the window) is treated as another isolated
   *  blip and re-resolved. */
  transient?: boolean;
}

/** A transient-class signature only escalates if it RECURS within this window of its prior
 *  sighting — a chronic failure re-fires every cron beat (well under an hour), so a recurrence
 *  inside the window is "still broken / page"; a prior sighting older than this is just another
 *  isolated blip and stays auto-resolved. */
const TRANSIENT_RECUR_WINDOW_MS = 60 * 60_000;

/**
 * Record one (grouped) error into error_events and page the owners on a new signature
 * or a re-firing spike (rate-limited). Best-effort — never throws.
 *
 * Returns whether a fresh incident was opened + whether we paged this call (for tests/logs).
 */
export async function recordError(
  input: RecordErrorInput,
  adminClient?: Admin,
): Promise<{ opened: boolean; paged: boolean }> {
  try {
    const admin = adminClient ?? createAdminClient();
    const signature = signatureFor(input.source, input.keyParts);
    const occurrences = Math.max(1, input.occurrences ?? 1);
    const nowIso = new Date().toISOString();

    // Outage-aware (agent-outage-resilience Phase 2): a flood of transient 5xx/529/timeout errors
    // DURING a known Claude outage are symptoms downstream of the outage, not new bugs. While the
    // breaker is tripped we still RECORD them (visibility, grouped under the outage) but tag them
    // outage-correlated, don't page, and DON'T enqueue the repair fan-out (the repair agent needs
    // Claude to triage — it would just 529; the comprehensive fix is Phase 1's retry/no-swallow, not
    // N per-error proposals). A NEW signature opened during the outage is auto-resolved as transient.
    const breakerTripped = await isClaudeBreakerTripped(admin);

    const { data: existing } = await admin
      .from("error_events")
      .select("id, count, last_paged_at, last_seen_at")
      .eq("source", input.source)
      .eq("signature", signature)
      .maybeSingle();

    const transient = input.transient === true;

    if (!existing) {
      // New signature → open an incident (status 'open') + page. EXCEPT: an outage-window
      // signature OR a first-sight transient blip is auto-resolved (recorded + grouped for
      // visibility, but not churned — no page, no repair fan-out). A transient first-sight
      // leaves last_paged_at null so a recurrence WITHIN the window can escalate + page.
      const autoResolve = breakerTripped || transient;
      const { error } = await admin.from("error_events").insert({
        source: input.source,
        signature,
        title: input.title.slice(0, 300),
        detail: input.detail ?? null,
        sample: input.sample ?? null,
        count: occurrences,
        status: autoResolve ? "resolved" : "open",
        outage_correlated: breakerTripped,
        first_seen_at: nowIso,
        last_seen_at: nowIso,
        last_paged_at: transient ? null : nowIso,
      });
      if (error) {
        // Racing insert (23505) — fall through to the update path.
        if (error.code === "23505") return recordError({ ...input, occurrences }, admin);
        console.warn(`[error-feed] insert failed for ${signature}:`, error.message);
        return { opened: false, paged: false };
      }
      if (autoResolve) {
        // Outage symptom OR a one-off transient blip — recorded for visibility, no page + no repair fan-out.
        return { opened: true, paged: false };
      }
      await pageOwners(admin, input, signature, occurrences);
      // Repair Agent trigger: a NEW signature is the moment to enqueue a diagnose→propose-fix job
      // (event-driven, deduped by signature). Best-effort — never let it break the error path.
      await enqueueRepairJob(admin, { source: input.source, signature, title: input.title, errorEventId: null });
      return { opened: true, paged: true };
    }

    // Existing incident → fold in. Re-page only if past the cooldown (burst = one page) AND the breaker
    // is up (an outage-window re-fire is a symptom — fold it, tag it, but never re-page).
    const e = existing as { id: string; count: number | null; last_paged_at: string | null; last_seen_at: string | null };

    // A transient-class recurrence only escalates if it lands WITHIN the recur window of the prior
    // sighting (chronic → still broken). A prior sighting older than the window is just another
    // isolated blip — re-resolve it (fold count + bump last_seen_at), never page.
    if (transient) {
      const withinRecurWindow =
        e.last_seen_at != null && Date.now() - new Date(e.last_seen_at).getTime() <= TRANSIENT_RECUR_WINDOW_MS;
      if (!withinRecurWindow) {
        await admin
          .from("error_events")
          .update({
            title: input.title.slice(0, 300),
            detail: input.detail ?? null,
            sample: input.sample ?? null,
            count: (e.count ?? 0) + occurrences,
            status: "resolved",
            last_seen_at: nowIso,
          })
          .eq("id", e.id);
        return { opened: false, paged: false };
      }
      // within the window → chronic; fall through to the normal open+page path.
    }

    const cooledDown = !e.last_paged_at || Date.now() - new Date(e.last_paged_at).getTime() > PAGE_COOLDOWN_MS;
    const paged = cooledDown && !breakerTripped;
    await admin
      .from("error_events")
      .update({
        title: input.title.slice(0, 300),
        detail: input.detail ?? null,
        sample: input.sample ?? null,
        count: (e.count ?? 0) + occurrences,
        // Don't force-resolve a pre-existing genuine incident — just tag the outage correlation. A genuine
        // re-fire re-opens a repair-dispositioned row (status→open) and clears the stale resolution marker,
        // so the row never shows a "resolved, pending deploy" reason while actively re-firing
        // (fix-error-reconcile-endless-loop Phase 1).
        ...(breakerTripped ? { outage_correlated: true } : { status: "open", resolved_at: null, resolution_reason: null }),
        last_seen_at: nowIso,
        ...(paged ? { last_paged_at: nowIso } : {}),
      })
      .eq("id", e.id);

    if (paged) await pageOwners(admin, input, signature, (e.count ?? 0) + occurrences);
    return { opened: false, paged };
  } catch (err) {
    console.warn("[error-feed] recordError failed:", err instanceof Error ? err.message : err);
    return { opened: false, paged: false };
  }
}

/**
 * The app-layer Supabase DB-error reporter (error-feed-monitoring Phase 1).
 *
 * Call this anywhere code gets a non-null Supabase `{ error }` it would otherwise
 * swallow (the scorecard-upsert class). Pushes it to the Control Tower error feed —
 * no external creds needed. A no-op on a null/undefined error so call sites can
 * `reportDbError(error, …)` unconditionally.
 *
 *   const { error } = await admin.from("x").upsert(rows);
 *   if (error) await reportDbError(error, { op: "scorecard-upsert", table: "x" });
 */
export async function reportDbError(
  error: { message?: string; code?: string; details?: string; hint?: string } | null | undefined,
  context: { op: string; table?: string; [k: string]: unknown },
  adminClient?: Admin,
): Promise<void> {
  if (!error) return;
  const message = error.message ?? "unknown Supabase error";
  await recordError(
    {
      source: "supabase",
      keyParts: [context.op, context.table ?? "", error.code ?? "", message],
      title: `${context.op}${context.table ? ` (${context.table})` : ""}: ${message}`.slice(0, 300),
      detail: [message, error.details, error.hint].filter(Boolean).join(" · ") || null,
      sample: { ...context, code: error.code ?? null, details: error.details ?? null, hint: error.hint ?? null },
    },
    adminClient,
  );
}

// ── Liveness heartbeats (error-feed-honest-panels Phase 1) ───────────────────
// Each feeder records a lightweight "received a delivery" beat — SEPARATE from error
// rows — so a panel can tell "we're watching and it's clean" (green) from "we're not
// watching" (amber). Stored in loop_heartbeats under loop_id `feed:<source>`, kind
// 'feed' (kind is free text — these ids aren't in MONITORED_LOOPS so the monitor
// ignores them). Best-effort: a liveness write must never break the feed it reports on.

/** The loop_heartbeats loop_id a source's "received a delivery" beats are written under. */
export function feedLoopId(source: ErrorSource): string {
  return `feed:${source}`;
}

/**
 * Record that a feed source RECEIVED a delivery (a clean Vercel batch, a successful
 * Supabase-logs poll) — proof the feed is wired + live, independent of whether the
 * delivery contained any errors. Best-effort, never throws.
 */
// Throttle feed-delivery beats to ≤1/min per source. A feed beat is a LIVENESS signal
// ("the drain is wired + delivering") — one per minute proves that. The Vercel log drain
// firehoses batches (observed ~175/sec), and an unthrottled insert-per-delivery grew
// loop_heartbeats to 21M rows / 4.5 GB and timed out the control_tower_loop_beats RPC.
// In-memory debounce per warm instance is the fast path; the AUTHORITATIVE throttle is a
// UNIQUE partial index on loop_heartbeats(loop_id, date_trunc('minute', ran_at)) where
// kind='feed' + an atomic INSERT … ON CONFLICT DO NOTHING (record_feed_beat). The old
// non-atomic SELECT-then-INSERT recency guard let a drain burst across many cold instances
// all SELECT-miss then all INSERT (15,508 feed:vercel beats in one hour vs ≤60 intended),
// storming the table into DB-saturation 500s (signature supabase-logs:6f16957ed72e1f38).
const FEED_BEAT_MIN_INTERVAL_MS = 60_000;
const lastFeedBeatAt = new Map<string, number>();
// Bounded client-side timeout on the record_feed_beat RPC. Under Vercel drain firehose bursts the
// Supabase gateway occasionally holds a same-minute racer past its edge deadline and returns a 504
// that the vercel-drain feed then re-ingests — a self-echoing error signature about the very beat
// the RPC exists to observe (Control Tower `supabase-logs:0356e510f43cf142`). 3s is well above p99
// for a one-line ON CONFLICT DO NOTHING and well under the gateway deadline, so the timer only
// ever trips on a genuinely stuck response and cuts the 504 off before it can self-feed
// ([[../specs/record-feed-beat-bounded-client-timeout-no-hung-liveness-rpc]]).
const FEED_BEAT_RPC_TIMEOUT_MS = 3_000;

export async function recordFeedDelivery(source: ErrorSource, adminClient?: Admin): Promise<void> {
  const loopId = feedLoopId(source);
  const now = Date.now();
  // Fast path: this warm instance beat for this source < 1 min ago → skip (no DB call).
  const lastLocal = lastFeedBeatAt.get(loopId) ?? 0;
  if (now - lastLocal < FEED_BEAT_MIN_INTERVAL_MS) return;
  // Mark before the DB call so a burst on THIS instance can't queue N concurrent RPCs. This
  // ALSO makes the bounded-timeout path below safe to swallow silently: if the RPC is aborted
  // at 3s we've already done the "one call per warm instance per minute" bookkeeping, so the
  // next call within 60s fast-paths regardless, and the DB's UNIQUE partial index
  // `loop_heartbeats_feed_minute_uidx` already guarantees at-most-one same-minute row across
  // cold instances — a swallowed timeout can't corrupt liveness state.
  lastFeedBeatAt.set(loopId, now);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEED_BEAT_RPC_TIMEOUT_MS);
  try {
    const admin = adminClient ?? createAdminClient();
    // Atomic cross-instance throttle: the DB collapses every same-minute racer to one row. A
    // burst that all gets past the fast path (cold/concurrent instances) no-ops at the DB
    // instead of all inserting — no read-then-write race, no insert storm.
    //
    // Bounded client-side timeout: race the RPC against a 3s AbortController timer (the same
    // pattern used in packing-slip-message.ts / claude-health.ts / meta-product-match.ts). A
    // best-effort liveness beat must never monopolize a serverless invocation for a minute or
    // fabricate a 504 error signature about itself; on timeout resolve as a silent no-op —
    // NOT a console.warn, a timeout is expected best-effort behaviour, not an error to
    // surface. The existing warn path stays for genuine non-timeout RPC errors.
    const raced = await Promise.race<{ kind: "rpc"; error: { message: string } | null } | { kind: "timeout" }>([
      admin.rpc("record_feed_beat", { p_loop_id: loopId }).then((r) => ({ kind: "rpc", error: r.error })),
      new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => resolve({ kind: "timeout" }), { once: true });
      }),
    ]);
    if (raced.kind === "timeout") return; // silent no-op — see comment above
    if (raced.error) console.warn(`[error-feed] feed-delivery beat failed for ${source}:`, raced.error.message);
  } catch (e) {
    console.warn(`[error-feed] feed-delivery beat failed for ${source}:`, e instanceof Error ? e.message : e);
  } finally {
    clearTimeout(timer);
  }
}

/** Page the owners of every Slack-connected workspace about an error incident. */
async function pageOwners(admin: Admin, input: RecordErrorInput, signature: string, total: number): Promise<void> {
  const { data } = await admin
    .from("workspace_members")
    .select("workspace_id")
    .in("role", ["owner", "admin"])
    .not("slack_user_id", "is", null);
  const wsIds = Array.from(new Set(((data ?? []) as Array<{ workspace_id: string }>).map((m) => m.workspace_id)));
  for (const wsId of wsIds) {
    await notifyOpsAlert(wsId, {
      title: `Control Tower: ${SOURCE_LABEL[input.source]} 🔴`,
      severity: "critical",
      lines: [
        input.title,
        input.detail ? input.detail.slice(0, 400) : "",
        total > 1 ? `${total} occurrences so far` : "first occurrence",
        "See /dashboard/developer/control-tower",
      ].filter(Boolean),
    });
  }
}

// ── Dashboard snapshot (read-only) ───────────────────────────────────────────

export interface ErrorIncident {
  id: string;
  source: ErrorSource;
  signature: string;
  title: string;
  detail: string | null;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
}

export type PanelColor = "green" | "amber" | "red";

/**
 * Connection state of a feed — the honesty layer (error-feed-honest-panels):
 *   - not-configured — the feed's secret/token isn't set; we CAN'T observe it. Amber.
 *   - awaiting       — configured but zero deliveries ever; not yet verified live. Amber.
 *   - connected      — received deliveries + zero errors in the window. The only true green.
 *   - errors         — errors present in the window (red/amber by recency, today's behavior).
 */
export type PanelConnectionState = "not-configured" | "awaiting" | "connected" | "errors";

export interface ErrorFeedPanel {
  source: ErrorSource;
  /** errors→red/amber by recency · not-configured/awaiting→amber · connected→green. */
  color: PanelColor;
  /** incidents seen in the lookback window. */
  incidents: ErrorIncident[];
  /** distinct active signatures in the window. */
  activeSignatures: number;
  /** total occurrences across active signatures. */
  totalOccurrences: number;
  /** is the feed's secret/token wired so we can actually observe it? */
  configured: boolean;
  /** last "received a delivery" beat (proof the feed is live), or null. */
  lastReceivedAt: string | null;
  /** the honesty state driving color + copy. */
  connectionState: PanelConnectionState;
  /** human-readable one-liner for the panel (e.g. "connected · 0 errors (last delivery 5m ago)"). */
  statusText: string;
  /** one-line "how to wire" hint, set only when not-configured. */
  hint: string | null;
}

export interface ErrorFeedSnapshot {
  generatedAt: string;
  panels: ErrorFeedPanel[];
}

const FEED_LOOKBACK_MS = 7 * 24 * 60 * 60_000; // surface the last week of error activity.
const RED_MS = 60 * 60_000; // any error in the last hour ⇒ panel red.
const AMBER_MS = 24 * 60 * 60_000; // any in the last day ⇒ amber.
const PANEL_INCIDENT_LIMIT = 8;

const SOURCES: ErrorSource[] = ["vercel", "inngest", "supabase", "supabase-logs", "client"];

/**
 * Which sources need a "received a delivery" proof before they can go green.
 *   - vercel / supabase-logs — wired feeds with an observable clean delivery (a drain
 *     POST / a successful poll) — need a `feed:<source>` beat.
 *   - inngest — failure-only (no clean delivery to observe); liveness is proxied by the
 *     freshness of Inngest itself (any recent cron beat) — needs that proxy beat.
 *   - supabase (app-layer) — reportDbError is wired unconditionally into live code paths
 *     (no setup, no separate delivery to observe); it's connected whenever it's clean.
 */
const REQUIRES_RECEIPT: Record<ErrorSource, boolean> = {
  vercel: true,
  inngest: true,
  supabase: false,
  "supabase-logs": true,
  // client — the storefront/portal reporters POST every error AND a per-session
  // heartbeat to /api/client-errors (which writes a feed:client beat); a panel is
  // "connected" only once we've actually received one, not just because no crash fired.
  client: true,
};

/** One-line "how to wire" hint shown when a source isn't configured. */
const NOT_CONFIGURED_HINT: Record<ErrorSource, string> = {
  vercel: "Set VERCEL_LOG_DRAIN_SECRET and create the Vercel log drain pointed at /api/webhooks/vercel-logs.",
  inngest: "Deploy the inngest-failure-capture function so failed runs are captured.",
  supabase: "reportDbError is wired in code — no setup needed.",
  "supabase-logs": "Paste a Supabase Management access token in the Control Tower (owner-only) to poll DB logs.",
  client: "The storefront + portal reporters POST to /api/client-errors — wired in code, no setup needed.",
};

/** Compact elapsed string from an ISO timestamp to now (e.g. "3m", "2h", "1d"). */
function elapsedSince(iso: string | null | undefined): string {
  if (!iso) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86_400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86_400)}d`;
}

/** Is the Supabase Management-logs poller configured (a token is stored)? Inlined here
 *  to avoid a circular import with supabase-log-poll (which imports recordError). */
async function isSupabaseLogsConfigured(admin: Admin): Promise<boolean> {
  try {
    const { data } = await admin
      .from("error_feed_supabase_config")
      .select("access_token_encrypted")
      .eq("id", "singleton")
      .maybeSingle();
    return Boolean((data as { access_token_encrypted: string | null } | null)?.access_token_encrypted);
  } catch {
    return false;
  }
}

/**
 * READ-ONLY: the per-source error panels for the Control Tower dashboard.
 *
 * Connection-aware (error-feed-honest-panels): a panel is green ONLY when its feed is
 * configured AND has received a delivery AND has zero errors in the window — "we're
 * watching and it's clean". A feed we can't observe (no secret/token) or haven't yet
 * seen a delivery from says so in amber, NOT a misleading green "0 errors".
 */
export async function buildErrorFeedSnapshot(adminClient?: Admin): Promise<ErrorFeedSnapshot> {
  const admin = adminClient ?? createAdminClient();
  const since = new Date(Date.now() - FEED_LOOKBACK_MS).toISOString();

  const [errRes, feedRes, cronRes, supabaseLogsConfigured] = await Promise.all([
    admin
      .from("error_events")
      .select("id, source, signature, title, detail, count, first_seen_at, last_seen_at")
      .gte("last_seen_at", since)
      .order("last_seen_at", { ascending: false })
      .limit(300),
    // Latest "received a delivery" beats for the feeds that emit them.
    admin
      .from("loop_heartbeats")
      .select("loop_id, ran_at")
      .in("loop_id", [feedLoopId("vercel"), feedLoopId("supabase-logs"), feedLoopId("client")])
      .order("ran_at", { ascending: false })
      .limit(50),
    // Inngest liveness proxy: any recent cron beat proves Inngest is delivering (and the
    // failure-capture fn, registered alongside, would catch a failure).
    admin
      .from("loop_heartbeats")
      .select("ran_at")
      .eq("kind", "cron")
      .order("ran_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    isSupabaseLogsConfigured(admin),
  ]);

  const rows = (errRes.data ?? []) as Array<ErrorIncident>;

  // Most-recent beat per feed loop_id (rows arrive newest-first).
  const feedLatest = new Map<string, string>();
  for (const b of (feedRes.data ?? []) as Array<{ loop_id: string; ran_at: string }>) {
    if (!feedLatest.has(b.loop_id)) feedLatest.set(b.loop_id, b.ran_at);
  }
  const latestCronAt = (cronRes.data as { ran_at: string } | null)?.ran_at ?? null;

  const configuredBy: Record<ErrorSource, boolean> = {
    vercel: Boolean(process.env.VERCEL_LOG_DRAIN_SECRET),
    inngest: true, // the capture fn is registered in code with the deploy.
    supabase: true, // reportDbError needs no setup — always wired.
    "supabase-logs": supabaseLogsConfigured,
    client: true, // the storefront/portal reporters are wired in code — always configured.
  };
  const receivedAtBy: Record<ErrorSource, string | null> = {
    vercel: feedLatest.get(feedLoopId("vercel")) ?? null,
    inngest: latestCronAt,
    supabase: null,
    "supabase-logs": feedLatest.get(feedLoopId("supabase-logs")) ?? null,
    client: feedLatest.get(feedLoopId("client")) ?? null,
  };

  const panels: ErrorFeedPanel[] = SOURCES.map((source) => {
    const incidents = rows.filter((r) => r.source === source);
    const activeSignatures = incidents.length;
    const totalOccurrences = incidents.reduce((s, r) => s + (r.count ?? 0), 0);
    const configured = configuredBy[source];
    const lastReceivedAt = receivedAtBy[source];

    let connectionState: PanelConnectionState;
    let color: PanelColor;
    let statusText: string;
    let hint: string | null = null;

    if (incidents.length > 0) {
      // Errors present → red/amber by recency (today's behavior, unchanged). Errors imply
      // the feed is live, so this always beats the connection states.
      color = "green";
      for (const inc of incidents) {
        const age = Date.now() - new Date(inc.last_seen_at).getTime();
        if (age <= RED_MS) {
          color = "red";
          break;
        }
        if (age <= AMBER_MS) color = "amber";
      }
      connectionState = "errors";
      statusText = `${activeSignatures} active signature${activeSignatures === 1 ? "" : "s"} · ${totalOccurrences} occurrence${totalOccurrences === 1 ? "" : "s"}`;
    } else if (!configured) {
      // Can't observe the source → amber, never a misleading green "0 errors".
      connectionState = "not-configured";
      color = "amber";
      statusText = "not configured — not watching this source";
      hint = NOT_CONFIGURED_HINT[source];
    } else if (REQUIRES_RECEIPT[source] && !lastReceivedAt) {
      // Configured but no delivery seen yet → not verified live.
      connectionState = "awaiting";
      color = "amber";
      statusText = "awaiting first event — not yet verified live";
    } else {
      // Configured + receiving (or no receipt needed) + clean → the only true green.
      connectionState = "connected";
      color = "green";
      statusText = lastReceivedAt
        ? `connected · 0 errors (last delivery ${elapsedSince(lastReceivedAt)} ago)`
        : "connected · 0 errors";
    }

    return {
      source,
      color,
      incidents: incidents.slice(0, PANEL_INCIDENT_LIMIT),
      activeSignatures,
      totalOccurrences,
      configured,
      lastReceivedAt,
      connectionState,
      statusText,
      hint,
    };
  });

  return { generatedAt: new Date().toISOString(), panels };
}
