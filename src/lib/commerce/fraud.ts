/**
 * commerce/fraud.ts — Display + Mutation ops for fraud cases.
 *
 * Phase 1 declares the surface; implementations arrive in M2b / M2c. The
 * orchestrator bails on any `status='confirmed_fraud'` or
 * `rule_type='amazon_reseller'` — the Display op carries `status` + `rule_type`
 * so upstream gates stay one read away.
 *
 * Canonical view: `FraudView` in `./types.ts`.
 */

export type { FraudView } from "./types";
