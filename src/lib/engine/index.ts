/**
 * The shared engine — pure logic that ShopCX and ShopGrowth both run on.
 *
 * Everything under `src/lib/engine/` takes data in and returns a verdict: no
 * database, no network, no secrets, no clock, nothing specific to either
 * business. ShopCX's wiring (and later ShopGrowth's) loads data, calls in, and
 * acts on the result. Once the side-by-side run proves verdicts match, this
 * folder lifts verbatim into its own repo as a versioned package that both
 * sides pin.
 *
 * Purity is enforced by `scripts/_check-engine-purity.ts` (in `predeploy`).
 * Plan: docs/brain/libraries/engine.md.
 */
export const ENGINE_VERSION = "0.0.0";
