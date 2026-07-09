/**
 * Pure decision function for the outreach short-circuit lanes.
 *
 * Phase 3 of docs/brain/specs/outreach-tickets-deterministically-close-no-sol-dispatch-no-ai-cost.md.
 * Combines Phase 2's automated-sender pre-filter and Phase 1's classifier-bucket short-circuit
 * into ONE testable predicate so the four verification bullets pin the exact routing invariant
 * the handler runs on. The unified-ticket-handler calls the SAME predicate at BOTH short-circuit
 * sites — pre-classifier (no bucket yet) and post-classifier (bucket resolved) — which is why
 * `classifierBucket` is optional.
 *
 * Return shape is a discriminated union so callers switch on `kind` and get exhaustive checks.
 *
 * `pre_filter_close`  — Phase 2 fired: automated-sender/body markers matched, classifier SKIPPED.
 * `classifier_close`  — Phase 1 fired: classifier returned "outreach" (brand-collab / UGC pitch).
 * `continue`          — account/general (or agent-owned / not-new / etc.) — normal downstream.
 */
import { isAutomatedInbound } from "./automated-sender";

export type OutreachRoute =
  | { kind: "pre_filter_close"; reason: "automated_sender_or_body_marker"; solDispatched: false; classifierInvoked: false }
  | { kind: "classifier_close"; reason: "classifier_bucket_outreach"; solDispatched: false; classifierInvoked: true }
  | { kind: "continue"; solDispatched: boolean; classifierInvoked: boolean };

export interface OutreachRouteInput {
  isNew: boolean;
  senderEmail: string | null | undefined;
  body: string | null | undefined;
  classifierBucket?: "account" | "general" | "outreach";
  solFirstTouchEnabled?: boolean;
  agentAssigned?: boolean;
}

/**
 * Deterministic: what does the unified-ticket-handler do with this inbound?
 *
 * Order matters — Phase 2's pre-filter runs BEFORE the classifier (zero AI when it hits), so
 * this function returns `pre_filter_close` before ever inspecting `classifierBucket`. Only when
 * the pre-filter misses AND `classifierBucket` is supplied do we consult the Phase 1 lane.
 *
 * A `continue` result reports whether Sol's first-touch dispatch would fire on the downstream
 * path (the handler's actual predicate: `isNew && sol_first_touch_enabled && !agentAssigned &&
 * msgType !== "outreach"` — the msgType clause is guaranteed non-outreach by the time we hit
 * `continue`).
 */
export function decideOutreachRoute(input: OutreachRouteInput): OutreachRoute {
  if (input.isNew && isAutomatedInbound(input.senderEmail, input.body)) {
    return {
      kind: "pre_filter_close",
      reason: "automated_sender_or_body_marker",
      solDispatched: false,
      classifierInvoked: false,
    };
  }
  if (input.isNew && input.classifierBucket === "outreach") {
    return {
      kind: "classifier_close",
      reason: "classifier_bucket_outreach",
      solDispatched: false,
      classifierInvoked: true,
    };
  }
  const solDispatched =
    !!input.isNew &&
    !!input.solFirstTouchEnabled &&
    !input.agentAssigned;
  return {
    kind: "continue",
    solDispatched,
    classifierInvoked: input.classifierBucket !== undefined,
  };
}
