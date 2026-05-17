/**
 * AsyncLocalStorage-based context + logger for Appstle (and other
 * subscription-platform) API calls triggered by direct actions.
 *
 * Every Appstle fetch wraps with logAppstleCall() to record:
 *   • action_type (swap_variant, apply_coupon, etc.)
 *   • request URL, body, method
 *   • response status, body
 *   • success/failure + error summary
 *   • back-link to the ticket that triggered it
 *
 * The action executor wraps each direct-action handler in
 * withActionContext() so the helpers fetch the ticket/workspace ids
 * implicitly — no need to thread them through every helper signature.
 */
import { AsyncLocalStorage } from "async_hooks";
import { createAdminClient } from "@/lib/supabase/admin";

interface ActionLogContext {
  workspaceId: string;
  ticketId: string | null;
  customerId: string | null;
  actionType: string;
}

const als = new AsyncLocalStorage<ActionLogContext>();

export function withActionContext<T>(
  ctx: ActionLogContext,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run(ctx, fn);
}

export function getActionContext(): ActionLogContext | undefined {
  return als.getStore();
}

interface CallLogParams {
  url: string;
  method?: string;
  body?: unknown;
  endpoint?: string;
  status: number;
  responseBody?: string;
  success: boolean;
  durationMs?: number;
}

/**
 * Log an API call. No-op if there's no action context (e.g. portal
 * routes call the same Appstle helpers — those have their own
 * logging path and shouldn't double-log here).
 */
export async function logAppstleCall(params: CallLogParams): Promise<void> {
  const ctx = als.getStore();
  if (!ctx) return; // Outside action-executor; skip.

  try {
    const admin = createAdminClient();
    // Extract a short error summary for failures
    let errorSummary: string | null = null;
    if (!params.success && params.responseBody) {
      try {
        const parsed = JSON.parse(params.responseBody);
        errorSummary = parsed?.title || parsed?.message || parsed?.error || params.responseBody.slice(0, 200);
      } catch {
        errorSummary = params.responseBody.slice(0, 200);
      }
    }

    await admin.from("appstle_api_calls").insert({
      workspace_id: ctx.workspaceId,
      ticket_id: ctx.ticketId,
      customer_id: ctx.customerId,
      action_type: ctx.actionType,
      endpoint: params.endpoint || null,
      request_method: params.method || "POST",
      request_url: stripApiKey(params.url),
      request_body: typeof params.body === "string" ? safeParseJson(params.body) : params.body || null,
      response_status: params.status,
      response_body: params.responseBody?.slice(0, 4000) || null,
      success: params.success,
      error_summary: errorSummary,
      duration_ms: params.durationMs || null,
    });
  } catch (err) {
    console.error("[appstle-call-log] insert failed:", err);
  }
}

/** Don't store API keys in the URL column even if they appeared in the request. */
function stripApiKey(url: string): string {
  return url.replace(/([?&])api_key=[^&]+/gi, "$1api_key=***");
}

function safeParseJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Drop-in wrapper around fetch() for Appstle endpoints. Captures the
 * request + response and logs it via logAppstleCall(). Returns the
 * original Response so callers don't need to change downstream parsing.
 *
 * Endpoint label is optional; when omitted we infer it from the path.
 */
export async function loggedAppstleFetch(
  url: string,
  init?: RequestInit,
  endpoint?: string,
): Promise<Response> {
  const t0 = Date.now();
  const res = await fetch(url, init);
  let body = "";
  try { body = await res.clone().text(); } catch { /* ignore */ }
  const inferredEndpoint = endpoint
    || (url.match(/\/api\/external\/v2\/([^?]+)/)?.[1] ?? "appstle");
  await logAppstleCall({
    url,
    method: (init?.method as string) || "GET",
    body: init?.body ? safeParseJson(String(init.body)) : undefined,
    endpoint: inferredEndpoint,
    status: res.status,
    responseBody: body,
    success: res.ok,
    durationMs: Date.now() - t0,
  });
  return res;
}

/**
 * Generic fetch wrapper for non-Appstle action calls (Shopify draft
 * orders, EasyPost, etc). Same logging surface as loggedAppstleFetch
 * but with explicit endpoint labeling since we can't infer from URL.
 *
 * The "success" boolean factors in GraphQL-style errors that come
 * back with HTTP 200 — without this, a Shopify userErrors response
 * would log as success=true while the action actually failed.
 */
export async function loggedActionFetch(
  url: string,
  init: RequestInit,
  opts: { endpoint: string; bodySuccessCheck?: (body: string) => boolean },
): Promise<Response> {
  const t0 = Date.now();
  const res = await fetch(url, init);
  let body = "";
  try { body = await res.clone().text(); } catch { /* ignore */ }
  let success = res.ok;
  if (success && opts.bodySuccessCheck) {
    try { success = opts.bodySuccessCheck(body); } catch { /* keep res.ok */ }
  }
  await logAppstleCall({
    url,
    method: (init.method as string) || "POST",
    body: init.body ? safeParseJson(String(init.body)) : undefined,
    endpoint: opts.endpoint,
    status: res.status,
    responseBody: body,
    success,
    durationMs: Date.now() - t0,
  });
  return res;
}
