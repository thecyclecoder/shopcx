/**
 * Unit tests for buildFounderApprovalPreview — the plain-language line the founder reads on their
 * phone for a June escalate_founder approval. Works for ANY recommended remedy, not just money.
 *
 * Run: npx tsx --test src/lib/june-remedy-approval.founderPreview.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildFounderApprovalPreview } from "./june-remedy-approval";

test("free one-time gift → 'Comp a FREE one-time gift for <name>'", () => {
  const p = buildFounderApprovalPreview({
    remedy: { action_type: "add_one_time_gift", payload: { contract_id: "x", variant_id: "y", free: true } },
    reasoning: "No gift policy exists; loyal customer.",
    customerName: "Mandi",
    ticketSubject: "Frother",
  });
  assert.match(p, /Comp a FREE one-time gift for Mandi/);
  assert.match(p, /re: "Frother"/);
  assert.match(p, /June: No gift policy exists/);
});

test("paid one-time add → 'Add a one-time item'", () => {
  const p = buildFounderApprovalPreview({
    remedy: { action_type: "add_one_time_gift", payload: { free: false } },
  });
  assert.match(p, /Add a one-time item/);
  assert.doesNotMatch(p, /FREE/);
});

test("money action reuses the dollarized summary", () => {
  const p = buildFounderApprovalPreview({
    remedy: { action_type: "partial_refund", payload: { amount_cents: 4800 } },
    customerName: "Susan",
  });
  assert.match(p, /Refund \$48\.00 for Susan/);
});

test("replacement money action → 'Send a replacement worth'", () => {
  const p = buildFounderApprovalPreview({
    remedy: { action_type: "create_replacement_order", payload: { amount_cents: 2500 } },
  });
  assert.match(p, /Send a replacement worth \$25\.00/);
});

test("unknown action type → generic 'Run \"<type>\"'", () => {
  const p = buildFounderApprovalPreview({ remedy: { action_type: "some_new_action" } });
  assert.match(p, /Run "some_new_action"/);
});

test("no action type → 'June's recommended action'", () => {
  const p = buildFounderApprovalPreview({ remedy: {} });
  assert.match(p, /June's recommended action/);
});

test("reasoning is truncated to 500 chars", () => {
  const p = buildFounderApprovalPreview({ remedy: { action_type: "x" }, reasoning: "z".repeat(900) });
  const why = p.split("June: ")[1] || "";
  assert.equal(why.length, 500);
});
