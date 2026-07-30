import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    "customer-fraud-status-selects-nonexistent-updated-at",
    {
      title: "Fix customer fraud-status: it selects fraud_cases.updated_at (a column that doesn't exist), so the query errors and every customer reads as fraud-clean",
      why: "getCustomerFraudStatus selects fraud_cases.updated_at, but fraud_cases has no updated_at column (its timestamps are first_detected_at, last_seen_at, created_at). Postgres returns 42703 (undefined column), so the query fails and returns null. The caller does not check the error, so cases is treated as empty and the function reports NO confirmed cases, NO open cases, and reseller-flagged = false for EVERY customer — even confirmed-fraud or amazon-reseller ones. The customer fraud-status check is effectively blind, which is a security-relevant silent failure.",
      what: "Drop the nonexistent updated_at from the select and use last_seen_at (the case's real last-touched timestamp, which the code already falls back to) for confirmed_at.",
      summary: "In src/lib/customer-fraud-status.ts remove updated_at from the fraud_cases select (~line 122) and set confirmed_at from last_seen_at (~line 134), matching the actual fraud_cases schema (first_detected_at, last_seen_at, created_at — no updated_at).",
      owner: "platform",
      parent: '[[../functions/platform]] — "Infra & DevOps / reliability" mandate: a fraud-status reader querying a nonexistent column fails closed to \"clean\" for every customer — a silent correctness/security failure in a risk-gating path. See [[../libraries/fraud-detector]] and [[../tables/fraud_cases]].',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — Select an existing column; use last_seen_at for confirmed_at",
          why: "The select references a column that doesn't exist, so the whole query errors and the fraud check silently returns clean.",
          what: "Remove updated_at from the select and derive confirmed_at from last_seen_at.",
          body: "In src/lib/customer-fraud-status.ts: (1) change the fraud_cases select (~line 122) from `\"id, rule_type, title, severity, status, first_detected_at, last_seen_at, updated_at\"` to drop `, updated_at` (the column does not exist — verified against the live fraud_cases schema, which has first_detected_at, last_seen_at, created_at). (2) change confirmed_at (~line 134) from `(c.updated_at || c.last_seen_at)` to `c.last_seen_at` (last_seen_at is the case's last-touched timestamp — fraud-detector updates it on each re-detection — and was already the fallback). Optionally also check the query error and log it so a future schema mismatch surfaces instead of failing silently to 'clean'. Do NOT add an updated_at column — last_seen_at is the correct existing timestamp. Update docs/brain/tables/fraud_cases.md (no updated_at; last_seen_at is the touch timestamp) per CLAUDE.md.",
          verification: "- tsc clean\n- customer-fraud-status no longer references fraud_cases.updated_at",
          checks: [
            { position: 1, description: "tsc --noEmit clean", kind: "auto", exec_kind: "tsc", params: null },
            { position: 2, description: "updated_at is no longer referenced in customer-fraud-status", kind: "auto", exec_kind: "grep", params: { pattern: "updated_at", path: "src/lib/customer-fraud-status.ts", expect: "absent" } },
            { position: 3, description: "last_seen_at is used for the confirmed timestamp", kind: "auto", exec_kind: "grep", params: { pattern: "last_seen_at", path: "src/lib/customer-fraud-status.ts", expect: "present" } },
          ],
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "platform#infra-devops-reliability" },
  );
  console.log(ok ? "authored" : "author write failed");
}
main().then(() => process.exit(0)).catch((e) => { console.error(String(e).slice(0, 500)); process.exit(1); });
