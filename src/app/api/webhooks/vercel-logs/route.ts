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
import { recordError, recordFeedDelivery } from "@/lib/control-tower/error-feed";

export const dynamic = "force-dynamic";

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
 */
function isBareLifecycle(message: string): boolean {
  const lines = message
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
      // The bare proxy summary line: "[POST] /api/portal?route=x status=502".
      /^\[[A-Z]+\]\s+\S+\s+status=\d{3}$/i.test(l),
  );
}

/** Is this log an error / 500-level entry worth surfacing? */
function isError(log: VercelLog): boolean {
  const status = log.statusCode ?? log.proxy?.statusCode ?? 0;
  const errorish = log.level === "error" || log.level === "fatal" || status >= 500;
  if (!errorish) return false;
  // Drop bare Lambda lifecycle/REPORT wrappers — non-actionable platform noise around a
  // failure the function already logged (and that already has its own signature).
  if (isBareLifecycle((log.message ?? "").trim())) return false;
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
    });
    recorded++;
  }

  return NextResponse.json({ received: logs.length, incidents: recorded });
}
