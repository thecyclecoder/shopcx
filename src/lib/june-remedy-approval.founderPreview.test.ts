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

test("replacement money action → 'Send a free replacement' (caller-supplied amount is NOT trusted)", () => {
  // Fix 1 (spec: replacements-must-work-for-internal-non-shopify-renewal-orders Phase 2) —
  // create_replacement_order's amount is untrusted (the executor always applies 100% discount
  // and ignores caller-supplied amount_cents / replacement_amount_cents). The founder preview
  // shows the intent without a dollar figure, so a verdict that set amount_cents=$25 can't
  // parade a false "worth $25" line past the CEO.
  const p = buildFounderApprovalPreview({
    remedy: { action_type: "create_replacement_order", payload: { amount_cents: 2500 } },
  });
  assert.match(p, /Send a free replacement/);
  assert.doesNotMatch(p, /\$25\.00/, "caller-supplied $25 must not appear in the preview");
});

test("dollar_replacement RETAINS the dollarized 'Send a replacement worth $X' preview (its amount is trusted)", () => {
  // dollar_replacement's executor fires a real refund on the original order, so its amount IS
  // trustworthy and the preview must keep the dollar figure so the CEO sees the exact spend.
  const p = buildFounderApprovalPreview({
    remedy: { action_type: "dollar_replacement", payload: { replacement_amount_cents: 2500 } },
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
