/**
 * inngest-failure-capture — capture errored Inngest runs (error-feed-monitoring Phase 1).
 *
 * Registers on the native `inngest/function.failed` event, which Inngest fires once
 * a function EXHAUSTS its retries. We record the failure into the Control Tower error
 * feed (source='inngest'), grouped by function id + error class so a flapping function
 * is ONE incident — and the owners are paged once per incident (not per retry, since
 * this fires only after the final retry). Real-time, no polling, no setup.
 *
 * See docs/brain/inngest/inngest-failure-capture.md · docs/brain/specs/error-feed-monitoring.md.
 */
import { inngest } from "@/lib/inngest/client";
import { recordError, isTransientInngestTransportError } from "@/lib/control-tower/error-feed";
import {
  APP_FUNCTION_ID_PREFIX,
  servedFunctionIds,
  servedFunctionBareIds,
} from "@/lib/inngest/registered-functions";

/** This function's own id — skip capturing its OWN failures (no self-loop). */
const SELF_ID = "inngest-failure-capture";

/**
 * Does this `function_id` belong to OUR app? The native `inngest/function.failed`
 * event is account-wide — it fires for EVERY app on the same Inngest account, so a
 * sibling project (e.g. `shopgrowth-amazon-sync-orders`, Prisma-based) bleeds into our
 * Control Tower feed (inngest-capture-scope-own-app spec). We scope to ours:
 *   - exact match against our served function ids (app-prefixed, "shopcx-…"), or
 *   - our app-id prefix ("shopcx-") — fail-open: an unknown-but-plausibly-ours id still
 *     records (better a rare foreign row than dropping a real one), or
 *   - the bare (un-prefixed) form, a tolerant fallback if Inngest ever reports bare ids.
 * A clearly-foreign id (no "shopcx-" prefix, not in our set) → not ours → ignored.
 */
function isOurFunction(functionId: string): boolean {
  return (
    servedFunctionIds.has(functionId) ||
    functionId.startsWith(APP_FUNCTION_ID_PREFIX) ||
    servedFunctionBareIds.has(functionId)
  );
}

interface FailedEventData {
  error?: { name?: string; message?: string; stack?: string } | string | null;
  function_id?: string;
  run_id?: string;
  event?: { name?: string } | null;
}

export const inngestFailureCapture = inngest.createFunction(
  {
    id: SELF_ID,
    name: "Control Tower — capture errored Inngest runs",
    retries: 1,
    triggers: [{ event: "inngest/function.failed" }],
  },
  async ({ event }) => {
    const data = (event.data ?? {}) as FailedEventData;
    const functionId = data.function_id ?? "unknown-function";

    // Never capture our own failure → infinite fan-out (match bare + app-prefixed form).
    if (functionId === SELF_ID || functionId === `${APP_FUNCTION_ID_PREFIX}${SELF_ID}`)
      return { skipped: "self" };

    // Scope to OUR app — the function.failed event is account-wide and sibling apps
    // on the same Inngest account otherwise bleed into the Control Tower feed.
    if (!isOurFunction(functionId)) return { skipped: "foreign-app", function_id: functionId };

    const err = data.error;
    const errName = typeof err === "object" && err ? err.name ?? "Error" : "Error";
    const errMessage =
      typeof err === "string" ? err : (typeof err === "object" && err ? err.message : null) ?? "function failed after retries";
    const triggerEvent = data.event?.name ?? null;

    // Inngest TRANSPORT noise (`http_unreachable` — Inngest couldn't get a clean reply from our
    // Vercel SDK URL; a deploy-boundary reap / connection reset, not an app throw): mark it
    // `transient` so recordError auto-resolves a first sighting (no page) and escalates only on
    // recurrence within the window — a one-off blip is dropped, a chronic timeout still surfaces.
    const transient = isTransientInngestTransportError(errName, errMessage);

    await recordError({
      source: "inngest",
      // Group by function + error class — flapping = one incident, not one per run.
      keyParts: [functionId, errName, errMessage],
      title: `${functionId}: ${errMessage}`,
      detail: `${errName}: ${errMessage}${triggerEvent ? ` (trigger: ${triggerEvent})` : ""}`,
      sample: {
        function_id: functionId,
        run_id: data.run_id ?? null,
        trigger_event: triggerEvent,
        error_name: errName,
      },
      transient,
    });

    return { captured: functionId, run_id: data.run_id ?? null };
  },
);
