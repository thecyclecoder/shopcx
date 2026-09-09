/**
 * The default "bin floor" — how many creatives a product must have banked before the
 * cadence will stop generating more.
 *
 * ⭐ This lives in its own leaf module on purpose. It used to be exported from
 * `creative-agent.ts`, and `inngest/ad-creative-cadence.ts` imported it from there — pulling
 * a 4,800-line module and its whole dependency tree in to read a single number. That tree
 * closes a cycle:
 *
 *   ad-creative-cadence → ads/creative-agent → agents/platform-director
 *     → control-tower/monitor → control-tower/self-audit → inngest/registered-functions
 *     → back to ad-creative-cadence
 *
 * `registered-functions` then reads `adCreativeCadenceCron` while that module is still
 * initialising, so ANY importer of `ad-creative-cadence` died with
 * `ReferenceError: Cannot access 'adCreativeCadenceCron' before initialization`. That is
 * what kept `ad-creative-cadence.gate.test.ts` — and therefore `npm run test:all` — red.
 *
 * Keep this module dependency-free. `creative-agent.ts` re-exports the constant so existing
 * importers are unaffected.
 */
export const DEFAULT_BIN_FLOOR = 4;
