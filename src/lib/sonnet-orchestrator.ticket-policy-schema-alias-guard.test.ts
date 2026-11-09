/**
 * Pins the ticket-policy schema-alias guard in buildPreContext.
 *
 * Ground truth: the live error was Postgres rejecting a `tickets.assigned_agent`
 * select, traced to an approved customer-support prompt (sonnet_prompts). Approved
 * conversation rules occasionally name a tickets column that does not exist —
 * `assigned_agent` (real column: `assigned_to`) and a bare `tickets.escalated`
 * (real columns: `escalated_at` / `escalated_to`). canonicalizeTicketPolicySchemaTerms
 * rewrites those known stale aliases BEFORE the prompt text reaches the model context
 * so Sol/Sonnet never reproduces the bad column name in a PostgREST read.
 *
 * Run: npx tsx --test src/lib/sonnet-orchestrator.ticket-policy-schema-alias-guard.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeTicketPolicySchemaTerms } from "./sonnet-orchestrator-v2";

test("rewrites the invented assigned_agent field to the real assigned_to column", () => {
  assert.equal(
    canonicalizeTicketPolicySchemaTerms("Set tickets.assigned_agent to the human owner."),
    "Set tickets.assigned_to to the human owner.",
  );
  // unqualified form is distinctive enough to rewrite too
  assert.equal(
    canonicalizeTicketPolicySchemaTerms("Check assigned_agent before replying."),
    "Check assigned_to before replying.",
  );
});

test("rewrites a bare qualified tickets.escalated to a real escalation column", () => {
  assert.equal(
    canonicalizeTicketPolicySchemaTerms("Read tickets.escalated to see if it was raised."),
    "Read tickets.escalated_at to see if it was raised.",
  );
});

test("leaves the already-correct escalation columns untouched", () => {
  const good = "Use tickets.escalated_at and tickets.escalated_to for escalation state.";
  assert.equal(canonicalizeTicketPolicySchemaTerms(good), good);
});

test("does not rewrite ordinary prose that merely says escalated", () => {
  const prose = "The box sweeps escalated tickets every hour.";
  assert.equal(canonicalizeTicketPolicySchemaTerms(prose), prose);
});

test("is a no-op for policy text that already uses real columns", () => {
  const clean = "Assign via tickets.assigned_to; never invent columns.";
  assert.equal(canonicalizeTicketPolicySchemaTerms(clean), clean);
});
