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
import { recordError } from "@/lib/control-tower/error-feed";

/** This function's own id — skip capturing its OWN failures (no self-loop). */
const SELF_ID = "inngest-failure-capture";

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

    // Never capture our own failure → infinite fan-out.
    if (functionId === SELF_ID) return { skipped: "self" };

    const err = data.error;
    const errName = typeof err === "object" && err ? err.name ?? "Error" : "Error";
    const errMessage =
      typeof err === "string" ? err : (typeof err === "object" && err ? err.message : null) ?? "function failed after retries";
    const triggerEvent = data.event?.name ?? null;

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
    });

    return { captured: functionId, run_id: data.run_id ?? null };
  },
);
