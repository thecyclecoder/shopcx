/**
 * POST /api/webhooks/vercel-logs — Vercel Log Drain sink (error-feed-monitoring Phase 1).
 *
 * The owner creates a Vercel Log Drain (JSON, delivery: batch, filtered to error /
 * 500-level runtime logs) pointed here, via the Vercel API with our token. Vercel then
 * POSTs batches of log objects, signed with `x-vercel-signature` = HMAC-SHA1(rawBody)
 * using the drain secret (VERCEL_LOG_DRAIN_SECRET).
 *
 * We verify the signature, defensively re-filter to error/500-level entries (belt-and-
 * suspenders over the drain's own filter), GROUP the batch by error signature (path +
 * status + normalized message) so a burst of the same 500 is ONE incident, and hand each
 * group to recordError (source='vercel') — which records + rate-limited-pages the owners
 * on a new signature or a re-firing spike. → the Control Tower "Vercel errors" panel.
 *
 * Drain-ownership verification: Vercel sends an `x-vercel-verify` token when wiring the
 * drain; we echo VERCEL_LOG_DRAIN_VERIFY (or any presented token) on GET + on POST.
 *
 * See docs/brain/integrations/vercel-log-drain.md · docs/brain/specs/error-feed-monitoring.md.
 */
import { NextResponse } from "next/server";
import crypto from "crypto";
import {
  recordError,
  recordFeedDelivery,
  isAbortedStreamNoise,
  isBareInngestStepErrorMiddlewareLog,
  isBareLifecycle,
  isTransientInngestStepRetryThrow,
  isTransientShopifyWebhookHmacFailure,
  isTransientSupabaseEdgeHtmlBody,
  isTransientUndiciHeadersTimeout,
} from "@/lib/control-tower/error-feed";


interface VercelLog {
  id?: string;
  message?: string;
  timestamp?: number;
  source?: string;
  level?: string;
  path?: string;
  host?: string;
  statusCode?: number;
  requestId?: string;
  deploymentId?: string;
  proxy?: { statusCode?: number; path?: string };
}

/** The ownership-verification token Vercel echoes back when wiring the drain. */
function verifyHeaderResponse(req: Request): Response | null {
  const presented = req.headers.get("x-vercel-verify");
  const configured = process.env.VERCEL_LOG_DRAIN_VERIFY || "";
  // Echo whichever token is in play so Vercel's wiring check passes.
  const token = presented || configured;
  if (token) {
    return new Response(token, { status: 200, headers: { "x-vercel-verify": token } });
  }
  return null;
}

// GET: Vercel's drain-ownership verification probe.
export async function GET(request: Request) {
  return verifyHeaderResponse(request) ?? new Response("ok", { status: 200 });
}

function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha1", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Is this log an error / 500-level entry worth surfacing? */
function isError(log: VercelLog): boolean {
  const status = log.statusCode ?? log.proxy?.statusCode ?? 0;
  const errorish = log.level === "error" || log.level === "fatal" || status >= 500;
  if (!errorish) return false;
  const message = (log.message ?? "").trim();
  // Drop bare Lambda lifecycle/REPORT wrappers — non-actionable platform noise around a
  // failure the function already logged (and that already has its own signature).
  if (isBareLifecycle(message)) return false;
  // Drop Node Web-Streams client-abort teardown noise (status 0, ignore-listed-only
  // stack) — non-actionable framework noise, same genre as the bare lifecycle wrappers.
  if (isAbortedStreamNoise(message, status)) return false;
  // Drop Inngest's built-in LoggerMiddleware bare "Inngest step error" log on
  // /api/inngest — terminal failures are already captured on source='inngest' via
  // inngest/function.failed; the bare label is duplicate noise on a healthy retry loop.
  const path = log.path ?? log.proxy?.path ?? null;
  if (isBareInngestStepErrorMiddlewareLog(message, path)) return false;
  return true;
}

/** A stable per-error group key for the batch + the keyParts recordError groups on. */
function groupKey(log: VercelLog): { key: string; path: string; status: number; message: string } {
  const path = log.path ?? log.proxy?.path ?? "unknown";
  const status = log.statusCode ?? log.proxy?.statusCode ?? 0;
  const message = (log.message ?? "").trim().slice(0, 500) || `${status} error`;
  return { key: `${path}|${status}|${message}`, path, status, message };
}

export async function POST(request: Request) {
  const secret = process.env.VERCEL_LOG_DRAIN_SECRET;
  const rawBody = await request.text();
  const signature = request.headers.get("x-vercel-signature");

  // No secret configured yet (owner hasn't generated it) ⇒ can't verify; refuse.
  if (!secret) {
    return NextResponse.json({ error: "Log drain not configured" }, { status: 503 });
  }
  if (!verifySignature(rawBody, signature, secret)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let logs: VercelLog[];
  try {
    const parsed = JSON.parse(rawBody);
    logs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Liveness: a verified delivery (even a clean batch with zero errors) proves the drain
  // is wired + live, so the Control Tower panel can show green "connected" instead of a
  // misleading green "0 errors" while disconnected. Best-effort — never blocks the 200.
  await recordFeedDelivery("vercel");

  // Defensive re-filter, then group the batch so a burst of the same error → ONE incident.
  const groups = new Map<string, { path: string; status: number; message: string; count: number; sample: VercelLog }>();
  for (const log of logs) {
    if (!isError(log)) continue;
    const g = groupKey(log);
    const cur = groups.get(g.key);
    if (cur) cur.count++;
    else groups.set(g.key, { path: g.path, status: g.status, message: g.message, count: 1, sample: log });
  }

  let recorded = 0;
  for (const g of groups.values()) {
    // Inngest STEP-RETRY noise (a `step.run` throwing to trigger its own retry — attempt
    // N/M with N<M; the function body never finally-failed) OR a Shopify webhook HMAC-
    // failure log on /api/webhooks/shopify(-returns) (a one-off probe with an invalid
    // signature — Shopify's own wiring check, a scanner, a stale-secret retry) OR an
    // undici outbound-fetch headers-timeout (`TypeError: fetch failed` with cause
    // `HeadersTimeoutError` / `UND_ERR_HEADERS_TIMEOUT` — a momentary upstream network
    // stall the next batch self-heals) OR a Supabase-edge Cloudflare 5xx HTML body leaked
    // into console.error text (`<!DOCTYPE html>` + `supabase.co` + `Web server`/521-524 —
    // the next beat idempotently heals): classify it `transient` so recordError
    // auto-resolves a first sighting (no page) and only escalates to a real open+page on
    // recurrence within the window — one-off blips are dropped while a function that
    // throws on every retry / a chronic signing bug / a chronic upstream outage still
    // surfaces.
    const transient =
      isTransientInngestStepRetryThrow(g.path, g.message) ||
      isTransientShopifyWebhookHmacFailure(g.path, g.message) ||
      isTransientUndiciHeadersTimeout(g.message) ||
      isTransientSupabaseEdgeHtmlBody(g.message);
    await recordError({
      source: "vercel",
      // Group on path + status + normalized message (stable bits, not requestId/deploymentId).
      keyParts: [g.path, String(g.status), g.message],
      title: `${g.status || "ERR"} ${g.path}: ${g.message}`.slice(0, 300),
      detail: g.message,
      sample: {
        path: g.path,
        status: g.status,
        host: g.sample.host ?? null,
        source: g.sample.source ?? null,
        requestId: g.sample.requestId ?? null,
        deploymentId: g.sample.deploymentId ?? null,
      },
      occurrences: g.count,
      transient,
    });
    recorded++;
  }

  return NextResponse.json({ received: logs.length, incidents: recorded });
}
