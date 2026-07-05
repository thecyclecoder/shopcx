/**
 * commerce/replacement.ts — Display + Mutation ops for replacements.
 *
 * Phase 1 declares the surface; implementations arrive in M2b / M2c. A
 * replacement is created from a source order and can adjust the linked
 * subscription's next billing date — that side effect belongs on the Mutation
 * op, not on any surface.
 *
 * Canonical view: `ReplacementView` in `./types.ts`.
 */

export type { ReplacementView } from "./types";
