/**
 * Unit tests for canonicalizeTicketPolicySchemaTerms — Phase 1 of
 * docs/brain/specs/ticket-policy-schema-alias-guard.md.
 *
 * The named failing state: an approved sonnet_prompts hard-gate rule told the
 * model to read `tickets.assigned_agent`, a column that never existed on
 * public.tickets (real fields: assigned_to for human ownership, escalated_at /
 * escalated_to for escalation state). That stale schema hint led Sol/Sonnet to
 * emit a PostgREST read for a non-existent column (2026-09-26 live error).
 *
 * The guard must rewrite the column-shaped aliases while leaving ordinary prose
 * ("the ticket was escalated to a human") and the already-correct field names
 * untouched (idempotent).
 *
 * Pure helper — no DB, no network, no clock. Run:
 *   npx tsx --test src/lib/sonnet-orchestrator-v2.canonicalize-ticket-policy-schema-terms.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeTicketPolicySchemaTerms } from "./sonnet-orchestrator-v2";

test("the 2026-09-26 scar — `assigned_agent` is rewritten to the real `assigned_to`", () => {
  assert.equal(
    canonicalizeTicketPolicySchemaTerms("check tickets.assigned_agent before replying"),
    "check tickets.assigned_to before replying",
  );
  assert.equal(
    canonicalizeTicketPolicySchemaTerms("if assigned_agent is set"),
    "if assigned_to is set",
  );
});

test("`tickets.escalated` boolean-shaped alias is rewritten to `tickets.escalated_at`", () => {
  assert.equal(
    canonicalizeTicketPolicySchemaTerms("when tickets.escalated is true"),
    "when tickets.escalated_at is true",
  );
});

test("ordinary prose 'escalated' is NOT rewritten (no false positive)", () => {
  const prose = "if the ticket was escalated to a human, do not keep solving";
  assert.equal(canonicalizeTicketPolicySchemaTerms(prose), prose);
});

test("already-correct field names are left untouched (idempotent)", () => {
  const good = "read assigned_to, escalated_at, and escalated_to";
  assert.equal(canonicalizeTicketPolicySchemaTerms(good), good);
  // Re-running the guard over its own output is a no-op.
  const once = canonicalizeTicketPolicySchemaTerms("tickets.assigned_agent and tickets.escalated");
  assert.equal(canonicalizeTicketPolicySchemaTerms(once), once);
});

test("empty / falsy content is passed through unchanged", () => {
  assert.equal(canonicalizeTicketPolicySchemaTerms(""), "");
});
