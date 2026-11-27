// Single source of truth for "does this journey completion route through the shared
// cancel handler?" — used by src/app/api/journey/[token]/complete/route.ts.
//
// The regression this fixes (11/22, 5b19a44c): a cancel_subscription session's stored
// config_snapshot carries journeyType but NOT cancelJourney (the GET loader only adds
// cancelJourney to the live-rendered copy, never writing it back). The complete route
// computed cancelFlow from config.cancelJourney before the code-driven block set it, so a
// confirmed cancel never reached the cancel handler — the session was marked
// outcome='cancelled' while the subscription kept billing.
//
// Security rule kept from fb8f4a14: the client-supplied cancel_flow flag ALONE must never
// route a non-cancel, non-next-order session (discount signup, add payment method, account
// linking, …) into the cancel path. It is honored only on a next-order session the server
// provisioned (config.nextOrderJourney === true).

const CANCEL_JOURNEY_TYPES = ["cancel_subscription", "cancellation", "cancel"] as const;

export function resolveCancelFlow(
  config: Record<string, unknown>,
  cancelFlowFlag: boolean | undefined,
): boolean {
  if (config.cancelJourney === true) return true;

  const journeyType = typeof config.journeyType === "string" ? config.journeyType : null;
  if (journeyType !== null && (CANCEL_JOURNEY_TYPES as readonly string[]).includes(journeyType)) {
    return true;
  }

  // Next-order session confirming an in-journey cancel: client flag honored ONLY here.
  if (config.nextOrderJourney === true && cancelFlowFlag === true) return true;

  return false;
}
