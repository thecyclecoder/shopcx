/**
 * Unit tests for the June founder-approval gate PURE predicates — the money-amount extractor, the
 * gate decision, and the plain-language preview. The IO paths (raiseJuneRemedyApproval /
 * executeApprovedJuneRemedies) are exercised via the box-worker sweep, not here.
 *
 * Run:
 *   npx tsx --test src/lib/june-remedy-approval.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  remedyMoneyAmountCents,
  remedyNeedsFounderApproval,
  buildJuneApprovalPreview,
  DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS,
  executeApprovedJuneRemedies,
} from "./june-remedy-approval";

test("remedyMoneyAmountCents reads amount_cents on a money action", () => {
  assert.equal(remedyMoneyAmountCents({ action_type: "partial_refund", payload: { amount_cents: 4800 } }), 4800);
});

test("remedyMoneyAmountCents reads replacement_amount_cents", () => {
  assert.equal(
    remedyMoneyAmountCents({ action_type: "dollar_replacement", payload: { replacement_amount_cents: 6995 } }),
    6995,
  );
});

test("remedyMoneyAmountCents returns null for a non-money action", () => {
  assert.equal(remedyMoneyAmountCents({ action_type: "change_next_date", payload: { amount_cents: 4800 } }), null);
});

test("remedyMoneyAmountCents returns null when amount is missing / non-finite", () => {
  assert.equal(remedyMoneyAmountCents({ action_type: "partial_refund", payload: {} }), null);
  assert.equal(remedyMoneyAmountCents({ action_type: "partial_refund", payload: { amount_cents: "x" } }), null);
  assert.equal(remedyMoneyAmountCents(null), null);
});

test("gate: sub-threshold refund runs autonomously (not gated)", () => {
  const g = remedyNeedsFounderApproval({ action_type: "partial_refund", payload: { amount_cents: 3000 } }, 5000);
  assert.equal(g.gated, false);
  assert.equal(g.amountCents, 3000);
  assert.equal(g.actionType, "partial_refund");
});

test("gate: at-threshold refund runs autonomously (strictly-above only)", () => {
  const g = remedyNeedsFounderApproval({ action_type: "partial_refund", payload: { amount_cents: 5000 } }, 5000);
  assert.equal(g.gated, false);
});

test("gate: over-threshold refund is gated", () => {
  const g = remedyNeedsFounderApproval({ action_type: "partial_refund", payload: { amount_cents: 5001 } }, 5000);
  assert.equal(g.gated, true);
  assert.equal(g.amountCents, 5001);
});

test("gate: money action with UNKNOWN amount is gated (conservative)", () => {
  const g = remedyNeedsFounderApproval({ action_type: "partial_refund", payload: {} }, 5000);
  assert.equal(g.gated, true);
  assert.equal(g.amountCents, null);
});

test("gate: non-money action never gated regardless of amount", () => {
  const g = remedyNeedsFounderApproval({ action_type: "change_next_date", payload: { amount_cents: 999999 } }, 5000);
  assert.equal(g.gated, false);
  assert.equal(g.actionType, "change_next_date");
});

test("gate: null/garbage remedy is not gated", () => {
  assert.equal(remedyNeedsFounderApproval(null, 5000).gated, false);
  assert.equal(remedyNeedsFounderApproval(undefined, 5000).gated, false);
});

test("gate: redeem_points_as_refund + create_replacement_order are money actions", () => {
  assert.equal(
    remedyNeedsFounderApproval({ action_type: "redeem_points_as_refund", payload: { amount_cents: 9000 } }, 5000).gated,
    true,
  );
  assert.equal(
    remedyNeedsFounderApproval(
      { action_type: "create_replacement_order", payload: { replacement_amount_cents: 9000 } },
      5000,
    ).gated,
    true,
  );
});

test("default threshold is $50", () => {
  assert.equal(DEFAULT_REFUND_APPROVAL_THRESHOLD_CENTS, 5000);
});

test("preview: refund reads plainly with name, subject, why", () => {
  const p = buildJuneApprovalPreview({
    actionType: "partial_refund",
    amountCents: 4800,
    customerName: "Susan",
    ticketSubject: "Wrong price",
    reasoning: "Portal showed the pre-discount price.",
  });
  assert.match(p, /Refund \$48\.00 to Susan on "Wrong price"\?/);
  assert.match(p, /Why: Portal showed the pre-discount price\./);
});

test("preview: replacement uses 'Send a replacement worth'", () => {
  const p = buildJuneApprovalPreview({ actionType: "create_replacement_order", amountCents: 6995 });
  assert.match(p, /Send a replacement worth \$69\.95\?/);
});

test("preview: unknown amount reads 'an unspecified amount'", () => {
  const p = buildJuneApprovalPreview({ actionType: "partial_refund", amountCents: null });
  assert.match(p, /Refund an unspecified amount\?/);
});

// ── Phase 3 (multi-action-remedies): gate SUMS money across ALL actions in the batch ──────────

test("Phase 3 — remedyMoneyAmountCents sums money across ALL money actions in actions[]", () => {
  // The spec's whole point: a $60 fix authored as 2×$30 must NOT dodge a $50 gate by splitting.
  // The extractor totals every money action in the batch (partial_refund + redeem_points_as_refund
  // + create_replacement_order + dollar_replacement) and reports the SUM.
  assert.equal(
    remedyMoneyAmountCents({
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 3000 } },
        { action_type: "redeem_points_as_refund", payload: { amount_cents: 3000 } },
      ],
    }),
    6000,
  );
});

test("Phase 3 — remedyMoneyAmountCents reads replacement_amount_cents in a multi-action batch", () => {
  // Mixed-source amounts — one action uses amount_cents, the other uses replacement_amount_cents
  // (the dollar_replacement shape). Both count into the SUM.
  assert.equal(
    remedyMoneyAmountCents({
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 2500 } },
        { action_type: "dollar_replacement", payload: { replacement_amount_cents: 4500 } },
      ],
    }),
    7000,
  );
});

test("Phase 3 — remedyMoneyAmountCents returns null when ANY money action has an unknown amount", () => {
  // Conservative: if any money action in the batch is a size-unknown refund, we CANNOT report a
  // total — the gate must escalate (unknown → gated). Non-money actions with missing amounts don't
  // trigger this rule.
  assert.equal(
    remedyMoneyAmountCents({
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 3000 } },
        { action_type: "partial_refund", payload: {} }, // unknown amount
      ],
    }),
    null,
  );
});

test("Phase 3 — remedyMoneyAmountCents sums ONLY money actions in a mixed batch", () => {
  // Non-money actions (change_next_date, resume, apply_coupon, redeem_points_as_credit_only, …)
  // never contribute to the total — their amount fields are semantically unrelated.
  assert.equal(
    remedyMoneyAmountCents({
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 3000 } },
        { action_type: "change_next_date", payload: { next_billing_date: "2026-10-06" } },
        { action_type: "redeem_points_as_refund", payload: { amount_cents: 2000 } },
      ],
    }),
    5000,
  );
});

test("Phase 3 — remedyMoneyAmountCents returns null for a batch of ONLY non-money actions", () => {
  // No money moved → the money extractor has nothing to report. Distinct from the "money action
  // with unknown amount" case (which returns null to force a gate).
  assert.equal(
    remedyMoneyAmountCents({
      actions: [
        { action_type: "change_next_date", payload: { next_billing_date: "2026-10-06" } },
        { action_type: "resume", payload: { contract_id: "c1" } },
      ],
    }),
    null,
  );
});

test("Phase 3 — GATE: 2×$30 (sum $60) OVER a $50 threshold GATES (can't split a refund to dodge)", () => {
  // The founder's directive (2026-07-10): the whole point of the sum-gate is that a single $60
  // refund and a 2×$30 split of the same refund MUST behave identically at the gate. This is the
  // core spec verification bullet.
  const g = remedyNeedsFounderApproval(
    {
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 3000 } },
        { action_type: "partial_refund", payload: { amount_cents: 3000 } },
      ],
    },
    5000,
  );
  assert.equal(g.gated, true);
  assert.equal(g.amountCents, 6000);
});

test("Phase 3 — GATE: multi-action sum UNDER threshold runs autonomously (not gated)", () => {
  // 2×$20 = $40, threshold $50 → sub-threshold → autonomous.
  const g = remedyNeedsFounderApproval(
    {
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 2000 } },
        { action_type: "redeem_points_as_refund", payload: { amount_cents: 2000 } },
      ],
    },
    5000,
  );
  assert.equal(g.gated, false);
  assert.equal(g.amountCents, 4000);
});

test("Phase 3 — GATE: UNKNOWN amount on ANY money action in the batch still GATES", () => {
  // Even if the KNOWN portions sum under threshold, an unknown amount forces the gate. Conservative:
  // never auto-fire a refund we can't size.
  const g = remedyNeedsFounderApproval(
    {
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 1000 } }, // $10 known
        { action_type: "partial_refund", payload: {} }, // UNKNOWN — forces gate
      ],
    },
    5000,
  );
  assert.equal(g.gated, true);
  assert.equal(g.amountCents, null);
});

test("Phase 3 — GATE: mixed money + non-money sums ONLY the money actions", () => {
  // A batch with 1 money + 1 non-money action gates on the money total, ignoring the non-money
  // action's payload entirely (a huge amount_cents accidentally on a change_next_date payload
  // must NOT count).
  const g = remedyNeedsFounderApproval(
    {
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 6000 } }, // over threshold
        { action_type: "change_next_date", payload: { next_billing_date: "2026-10-06" } },
      ],
    },
    5000,
  );
  assert.equal(g.gated, true);
  assert.equal(g.amountCents, 6000);
});

test("Phase 3 — GATE: back-compat single-action shape still works unchanged", () => {
  // The legacy `{action_type, payload}` shape stays gate-compatible — a $60 single refund still
  // gates over $50 and reports the same amount.
  const g = remedyNeedsFounderApproval(
    { action_type: "partial_refund", payload: { amount_cents: 6000 } },
    5000,
  );
  assert.equal(g.gated, true);
  assert.equal(g.amountCents, 6000);
  assert.equal(g.actionType, "partial_refund");
});

test("Phase 3 — GATE: multi-action batch of ONLY non-money actions is NOT gated", () => {
  // 2 non-money actions → no money to gate on → autonomous.
  const g = remedyNeedsFounderApproval(
    {
      actions: [
        { action_type: "change_next_date", payload: { next_billing_date: "2026-10-06" } },
        { action_type: "resume", payload: { contract_id: "c1" } },
      ],
    },
    5000,
  );
  assert.equal(g.gated, false);
});

test("Phase 3 — GATE: FounderApprovalDecision surfaces the per-money-action lines for the preview", () => {
  // The Phase-3 verification bullet: buildJuneApprovalPreview lists each money line + the total.
  // The gate exposes the money-only lines on the decision so the preview builder can render them
  // without re-walking the raw remedy.
  const g = remedyNeedsFounderApproval(
    {
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 3000 } },
        { action_type: "change_next_date", payload: { next_billing_date: "2026-10-06" } },
        { action_type: "redeem_points_as_refund", payload: { amount_cents: 3000 } },
      ],
    },
    5000,
  );
  assert.equal(g.gated, true);
  assert.equal(g.amountCents, 6000);
  assert.equal(g.moneyLines?.length, 2);
  assert.equal(g.moneyLines?.[0]?.actionType, "partial_refund");
  assert.equal(g.moneyLines?.[0]?.amountCents, 3000);
  assert.equal(g.moneyLines?.[1]?.actionType, "redeem_points_as_refund");
  assert.equal(g.moneyLines?.[1]?.amountCents, 3000);
});

test("Phase 3 — PREVIEW: a multi-line batch lists EACH money line item + the SUMMED total", () => {
  // Format contract: single-action preview stays exactly as it was ("Refund $X to Susan on 'Y'?").
  // Multi-line preview:
  //   - Names the SUM explicitly (so the founder knows the total dollars at a glance).
  //   - Lists each money line so the split is visible (no "one $60 refund" ambiguity).
  const p = buildJuneApprovalPreview({
    actionType: "partial_refund",
    amountCents: 6000,
    moneyLines: [
      { actionType: "partial_refund", amountCents: 3000 },
      { actionType: "redeem_points_as_refund", amountCents: 3000 },
    ],
    customerName: "Susan",
    ticketSubject: "Wrong price",
    reasoning: "Portal showed the pre-discount price.",
  });
  // The founder sees the TOTAL up-front (so a 2×$30 split can't hide the true spend).
  assert.match(p, /\$60\.00/);
  // Each line is listed with its dollar amount.
  assert.match(p, /\$30\.00/);
  // Both money action types are named (partial_refund + redeem_points_as_refund) so the shape of
  // the fix is legible without opening the tool_input.
  assert.match(p, /partial_refund/);
  assert.match(p, /redeem_points_as_refund/);
  // Customer + subject + Why still surface.
  assert.match(p, /Susan/);
  assert.match(p, /Wrong price/);
  assert.match(p, /Why:.*Portal showed the pre-discount price\./);
});

test("Phase 3 — PREVIEW: a single-line batch renders the legacy single-action string EXACTLY", () => {
  // Back-compat: a single-action remedy (moneyLines.length===1 OR moneyLines omitted) must render
  // the same "Refund $48.00 to Susan on 'Wrong price'?" text prior tests + prod SMSes rely on.
  const p = buildJuneApprovalPreview({
    actionType: "partial_refund",
    amountCents: 4800,
    moneyLines: [{ actionType: "partial_refund", amountCents: 4800 }],
    customerName: "Susan",
    ticketSubject: "Wrong price",
    reasoning: "Portal showed the pre-discount price.",
  });
  assert.match(p, /Refund \$48\.00 to Susan on "Wrong price"\?/);
  assert.match(p, /Why: Portal showed the pre-discount price\./);
});

// ── Phase 2 (multi-action-remedies): the parked-path executed_at idempotency stamp is preserved ──

test("executeApprovedJuneRemedies: a card whose tool_input.executed_at is already stamped is SKIPPED (idempotent re-drive)", async () => {
  // The parked-path idempotency contract: once the box-worker sweep has processed an approved /
  // denied god_mode_approvals card, it stamps `tool_input.executed_at` and the NEXT sweep must
  // short-circuit that card without re-firing the remedy (a double-refund would be catastrophic).
  // Phase 2 of multi-action-remedies extends the batch semantics but MUST NOT weaken this stamp —
  // the check at the top of the row loop must still guard the mutating branches.
  //
  // Stub the .from(...).select(...).eq(...).in(...).limit(...) chain the sweep uses to return one
  // already-stamped row, plus a lightweight .update() sink so we can assert the guard fires
  // BEFORE any stampExecuted / executeParkedRemedy call would run.
  const updateCalls: unknown[] = [];
  const admin = {
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                in(_c: string, _v: string[]) {
                  return {
                    async limit(_n: number) {
                      return {
                        data: [
                          {
                            id: "approval-1",
                            workspace_id: "ws-1",
                            status: "approved",
                            tool_input: {
                              ticket_id: "ticket-1",
                              remedy: {
                                action_type: "partial_refund",
                                payload: { amount_cents: 3000 },
                              },
                              executed_at: "2026-07-10T12:00:00.000Z",
                              execution_outcome: "executed",
                            },
                          },
                        ],
                        error: null,
                      };
                    },
                  };
                },
              };
            },
          };
        },
        update(row: unknown) {
          return {
            eq(_col: string, _val: string) {
              // A stampExecuted call would land here — assert none happen for the guarded row.
              updateCalls.push(row);
              return Promise.resolve({ data: null, error: null });
            },
          };
        },
      };
    },
  } as unknown as Parameters<typeof executeApprovedJuneRemedies>[0];

  const counts = await executeApprovedJuneRemedies(admin);
  // Guarded row was skipped → neither counter incremented AND stampExecuted was NEVER called (the
  // executed_at stamp is the compare-and-set that prevents a re-fire).
  assert.equal(counts.executed, 0);
  assert.equal(counts.denied, 0);
  assert.equal(updateCalls.length, 0, "stampExecuted must NOT re-fire on an already-stamped card");
});
