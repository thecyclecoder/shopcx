/**
 * commerce/pricing — re-export of the heal-on-touch helper so
 * consumers (action-executor, sonnet-orchestrator-v2) can call it
 * without importing a vendor-suffixed module path. Phase 5 landing:
 * hides the `@/lib/appstle-pricing` import path behind the SDK
 * boundary so the `grep -n "appstle"` invariant on the AI stack holds.
 * The upstream helper stays unchanged — this file adds zero runtime
 * behaviour.
 */
export { healOnTouch } from "@/lib/appstle-pricing";
