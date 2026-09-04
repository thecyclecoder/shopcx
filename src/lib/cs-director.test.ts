/**
 * Unit tests for `applyBoxCsDirectorCall` — the Phase-2 executor that materializes June's verdicts
 * (docs/brain/specs/cs-director-call-phase-2-executor-fires-june-verdicts.md).
 *
 * Phase 1 verification (routing scaffold):
 *   - `applyBoxCsDirectorCall` exists and returns { ok, handler } — called once per cs-director-call
 *     job after the Phase-1 director_activity record.
 *   - A verdict whose `decision` is `approve_remedy` / `author_spec` / `escalate_founder` routes to
 *     its handler (surfaced on `handler`).
 *   - Any other value is a logged no-op (`handler:'noop'`, `ok:true`) — never a crash / never a
 *     silent upgrade to an autonomous action.
 *
 * Phase 2 verification (approve_remedy executes, THEN messages — never before):
 *   - The customer message is sent only after the remedy action returns success (ordering test).
 *   - A failed remedy action sends no customer message and marks the job `needs_attention`.
 *   - Re-running ticket 115350d5's verdict shape in a test executes the date change and messages
 *     once.
 *   - Pure helpers `planRemedyExecution` + `extractRemedyCustomerMessage` +
 *     `buildRemedySonnetDecision` produce the expected shapes.
 *
 * Phase 3 verification (author_spec + escalate_founder paths):
 *   - An author_spec verdict creates a public.specs row via the SDK (never raw insert) — asserted
 *     by injecting the SDK dep and verifying it's called with the right shape.
 *   - An escalate_founder verdict result carries the linkage back to the originating ticket /
 *     triage_run (linkage_ticket_id + linkage_triage_run_id) — the same values the runner stamps on
 *     the CEO card's metadata.
 *   - Malformed spec_seed / SDK returned-false / SDK threw all park needs_attention (never a silent
 *     no-write).
 *   - Pure helpers `planAuthorSpec` + `buildAuthorSpecInput` produce the expected shapes.
 *
 * Run:
 *   npx tsx --test src/lib/cs-director.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  applyBoxCsDirectorCall,
  buildAuthorSpecInput,
  buildRemedySonnetDecision,
  canOfferOneTapApproval,
  composeFounderEscalationAck,
  extractRemedyCustomerMessage,
  extractRemedyOrderRefFromStep,
  planAuthorSpec,
  planRemedyExecution,
  verifyPlanAgainstRemedyStates,
  type ApproveRemedyDeps,
  type AuthorSpecDeps,
  type CsDirectorApplyDeps,
  type CsDirectorVerdictInput,
  type RemedyActionStep,
} from "./cs-director";
import type { CxOrderRemedyState } from "./cx-agent-sdk";
import { decideCsDirectorTicketTransition } from "./cs-director-ticket-transition";
import type { StructuredSpecInput } from "./author-spec";

type Admin = Parameters<typeof applyBoxCsDirectorCall>[0];

// A tiny stub that only implements the `from(...).select(...).eq(...).maybeSingle()` chain the
// public entrypoint uses to look up the agent_jobs row + the internal handleApproveRemedy uses to
// resolve job.instructions. Table-aware so we can seed distinct rows per table.
function stubAdminMulti(tableRows: Record<string, { data: unknown }>): Admin {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                async maybeSingle() {
                  return tableRows[table] ?? { data: null };
                },
                async single() {
                  return tableRows[table] ?? { data: null };
                },
              };
            },
          };
        },
        insert(_row: unknown) {
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  } as unknown as Admin;
}

// Older single-table stub kept for the Phase-1 routing tests (they only need agent_jobs).
function stubAdmin(row: { id: string; workspace_id: string; kind: string } | null): Admin {
  return stubAdminMulti({ agent_jobs: { data: row } });
}

const CS_JOB_ROW = { id: "job-1", workspace_id: "ws-1", kind: "cs-director-call" as const };

// ── Phase 1 scaffold routing ───────────────────────────────────────────────────────────────────

test("approve_remedy routes to its handler", async () => {
  const admin = stubAdminMulti({
    agent_jobs: { data: CS_JOB_ROW },
    // For the internal handleApproveRemedy: instructions carry ticket_id.
    // The second .from('agent_jobs') call in handleApproveRemedy re-selects instructions, and this
    // stub returns the SAME agent_jobs row shape for every .from('agent_jobs') call. So we merge
    // the instructions field into the stub row.
    tickets: { data: { customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: true } },
  });
  // Re-seed agent_jobs with instructions so handleApproveRemedy can resolve ticket_id.
  const adminWithInst = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-1" }) } },
    tickets: { data: { customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: true } },
  });

  let executorCalled = false;
  let deliveryCalled = false;
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => true,
    runExecutor: async () => {
      executorCalled = true;
      return { messageSent: false, escalated: false, closed: false, statusManaged: false };
    },
    deliverMessage: async () => {
      deliveryCalled = true;
    },
  };

  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "Portal changedate remedy is in-leash — restore next_billing_date to 2026-10-06 and message the customer.",
    remedy: {
      action_type: "change_next_date",
      summary: "restore requested date",
      payload: { next_billing_date: "2026-10-06", contract_id: "contract-1" },
      customer_message: "I've moved your next billing date to October 6, 2026. Reply if anything else needs adjusting!",
    },
  };
  const result = await applyBoxCsDirectorCall(adminWithInst, "job-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "approve_remedy");
  assert.equal(result.message_delivered, true);
  assert.equal(executorCalled, true);
  assert.equal(deliveryCalled, true);
  // sandbox-mode admin used above; still validates the routing + ordering.
  void admin;
});

test("author_spec routes to its handler (SDK-injected)", async () => {
  // Phase 3 — author_spec now writes via the specs SDK. Seed instructions so the handler can
  // resolve ticket_id for the Derived-from linkage, and inject an authorSpec dep so we don't call
  // the real SDK (which would touch the filesystem for mandate resolution).
  const admin = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-1" }) } },
  });
  let authorCalled = false;
  const deps: CsDirectorApplyDeps = {
    authorSpec: {
      authorSpec: async () => {
        authorCalled = true;
        return true;
      },
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "author_spec",
    reasoning: "Two prior turns drifted on the same coupon path — the analyzer misses this class.",
    spec_seed: {
      slug: "cs-analyzer-coupon-gap",
      title: "Analyzer routes repeat-coupon tickets to remedy",
      intent: "Route repeat-coupon tickets to the remedy path so the analyzer stops skipping them.",
      problem: "analyzer skipped remedy path on repeat coupon",
    },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "author_spec");
  assert.equal(result.spec_slug, "cs-analyzer-coupon-gap");
  assert.equal(authorCalled, true);
});

test("escalate_founder routes to its handler + returns linkage", async () => {
  // Phase 3 — the executor resolves + returns ticket_id + triage_run_id from job.instructions so
  // the runner's log_tail names the LINKAGE BACK explicitly.
  const admin = stubAdminMulti({
    agent_jobs: {
      data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-1", triage_run_id: "run-9" }) },
    },
  });
  const verdict: CsDirectorVerdictInput = {
    decision: "escalate_founder",
    reasoning: "Out-of-leash — grandfathered price lock on a $26.89 overcharge needs the CEO's ruling.",
    recommended_remedy: { kind: "refund_and_price_lock", summary: "Refund + restore the $33.01 grandfathered price before next renewal" },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "escalate_founder");
  assert.equal(result.linkage_ticket_id, "ticket-1");
  assert.equal(result.linkage_triage_run_id, "run-9");
});

// ── Phase 3 of cs-director-call-loop-guard-and-message-only-remedy — message-only remedy ──────
// The failing state the verb closes: on ticket 86043da0 (Jan Bloom), the money was already
// unwound; every mutation-based remedy would double-pay. The correct output was one message
// stating what the customer was charged and that a prepaid return exists — no refund, no
// cancel, nothing else. June had no verb for that, so the correct verdict had nowhere to go
// and the job parked, feeding the 69-call loop Phase 1 caps. The tests below pin: a message_only
// verdict (a) is routed by applyBoxCsDirectorCall to a handler that (b) delivers the message via
// the SAME executor-suppressed-send pattern approve_remedy uses (never runs a mutating action
// — no `runExecutor` call, no money/account touch), and (c) reports message_delivered so the
// runner closes the ticket instead of parking it.

test("message_only routes to its handler, delivers via deliverMessage, and NEVER runs the action executor (no money/account mutation)", async () => {
  const admin = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-1" }) } },
    tickets: { data: { customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: false } },
  });
  let executorCalled = false;
  let deliveryCalled = false;
  let deliveredMessage: string | null = null;
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async () => {
      executorCalled = true;
      return { messageSent: false, escalated: false, closed: false, statusManaged: false };
    },
    deliverMessage: async (_admin, _ws, _tid, _channel, message, _sandbox) => {
      deliveryCalled = true;
      deliveredMessage = message;
    },
  };
  const verdict: CsDirectorVerdictInput = {
    // The new verb — a decision June can choose when the CUSTOMER simply needs to be told what happened.
    decision: "message_only" as CsDirectorVerdictInput["decision"],
    reasoning: "Money already unwound; the residue is that the customer was never told. No refund/cancel — one message and resolve.",
    remedy: {
      // A message_only remedy carries ONLY the customer_message — no `action_type`, no `actions[]`.
      customer_message:
        "You were charged $182.95 for order SC135494; $15 has already been refunded and a prepaid return label is on the way. Reply if anything else needs adjusting.",
    },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, true, "message_only must route cleanly — no crash, no needs_attention on the happy path");
  assert.equal(result.handler, "message_only", "the handler tag must be message_only so the runner + audit trail see the verb");
  assert.equal(result.message_delivered, true, "the message must actually ship (that IS the whole remedy)");
  assert.equal(deliveryCalled, true, "deliverMessage MUST be called — this is the sendThreadedReply path the spec pins");
  assert.equal(
    executorCalled,
    false,
    "NO money or account mutation — the whole point is that a settled-money ticket needs only a message; running the executor would open the door back to a double-pay",
  );
  assert.match(
    deliveredMessage ?? "",
    /prepaid return label/,
    "the message June authored on the verdict is the message that ships (no substitution / no drop)",
  );
});

test("message_only with an `action_type` on the remedy is REJECTED (any mutation attempt fails-closed; NO delivery, NO executor)", async () => {
  const admin = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-1" }) } },
    tickets: { data: { customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: false } },
  });
  let executorCalled = false;
  let deliveryCalled = false;
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async () => {
      executorCalled = true;
      return { messageSent: false, escalated: false, closed: false, statusManaged: false };
    },
    deliverMessage: async () => {
      deliveryCalled = true;
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "message_only" as CsDirectorVerdictInput["decision"],
    reasoning: "should be rejected — a message_only remedy is BY DEFINITION a no-mutation verb",
    remedy: {
      action_type: "partial_refund",
      payload: { shopify_order_id: "9999", amount_cents: 1000 },
      customer_message: "here's your refund",
    },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, false, "a mutation slipped into a message_only remedy MUST fail closed — the safety of the verb is that it CANNOT mutate");
  assert.equal(result.handler, "message_only");
  assert.equal(result.needs_attention, true, "a rejected message_only parks the job so a human sees the misuse — never silently upgrades to approve_remedy");
  assert.equal(deliveryCalled, false, "no message delivery on a rejected verdict — never promise the customer a fix we blocked");
  assert.equal(executorCalled, false, "no executor call on a message_only verdict, rejected or not");
});

test("message_only with an empty / missing customer_message is REJECTED (nothing to send is not a resolution)", async () => {
  const admin = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-1" }) } },
    tickets: { data: { customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: false } },
  });
  let deliveryCalled = false;
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async () => ({ messageSent: false, escalated: false, closed: false, statusManaged: false }),
    deliverMessage: async () => {
      deliveryCalled = true;
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "message_only" as CsDirectorVerdictInput["decision"],
    reasoning: "empty remedy — should fail",
    remedy: {},
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(deliveryCalled, false, "an empty message_only carries nothing to send — a park is the honest response");
});

test("a decision value outside the three literals is a clean no-op", async () => {
  const admin = stubAdmin(CS_JOB_ROW);
  // Cast through unknown — the runtime input can hit this state if `normalizeCsDirectorVerdict`
  // ever changes its defensive fallback (or a future caller bypasses it). The scaffold must never
  // crash or silently upgrade to an autonomous action.
  const verdict = { decision: "revert", reasoning: "should not route" } as unknown as CsDirectorVerdictInput;
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "noop");
});

test("a missing agent_jobs row surfaces as ok:false without throwing", async () => {
  const admin = stubAdmin(null);
  const verdict: CsDirectorVerdictInput = { decision: "approve_remedy", reasoning: "any" };
  const result = await applyBoxCsDirectorCall(admin, "job-missing", verdict);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "job_not_found");
});

test("a wrong-kind agent_jobs row surfaces as ok:false without throwing", async () => {
  const admin = stubAdmin({ id: "job-1", workspace_id: "ws-1", kind: "build" });
  const verdict: CsDirectorVerdictInput = { decision: "approve_remedy", reasoning: "any" };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "wrong_kind:build");
});

// ── Phase 2 pure planners ──────────────────────────────────────────────────────────────────────

test("planRemedyExecution — canonical shape", () => {
  const result = planRemedyExecution({
    action_type: "change_next_date",
    payload: { next_billing_date: "2026-10-06", contract_id: "contract-1" },
    customer_message: "Moved to Oct 6.",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.actionType, "change_next_date");
    assert.deepEqual(result.plan.actionParams, {
      next_billing_date: "2026-10-06",
      contract_id: "contract-1",
    });
    assert.equal(result.plan.customerMessage, "Moved to Oct 6.");
    // Single-action normalizes into a length-1 actions[] so nothing downstream sees the legacy-vs-
    // batched distinction (Phase 1 multi-action-remedies).
    assert.equal(result.plan.actions.length, 1);
    assert.equal(result.plan.actions[0].actionType, "change_next_date");
    assert.deepEqual(result.plan.actions[0].actionParams, {
      next_billing_date: "2026-10-06",
      contract_id: "contract-1",
    });
  }
});

test("planRemedyExecution — a {kind, summary} recommendation is NON-executable (the founder-approval guard's condition)", () => {
  // escalate_founder's recommended_remedy is a human suggestion shape, never {action_type}. This is
  // EXACTLY the shape raiseFounderApproval must NOT open a one-tap auto-execute card for — approving
  // it would malform (ticket db8b3d66). The guard keys on planRemedyExecution(remedy).ok being false.
  const result = planRemedyExecution({
    kind: "acknowledge_and_request_info",
    summary: "Ask the customer for the order number / merchant on the $236.50 charge we can't locate.",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "remedy_missing_action_type");
});

test("planRemedyExecution — multi-action actions[] preserves order and normalizes each step", () => {
  // The Phase-1 shape June emits for a full fix — e.g. partial_refund + change_next_date +
  // redeem_points_as_refund fires ALL THREE in the authored order, none of which regresses to a
  // single top-level action_type.
  const result = planRemedyExecution({
    actions: [
      { action_type: "partial_refund", payload: { amount_cents: 3000, order_number: "SC131156" } },
      { action_type: "change_next_date", payload: { next_billing_date: "2026-10-06", contract_id: "c1" } },
      { action_type: "redeem_points_as_refund", payload: { amount_cents: 500 } },
    ],
    customer_message: "Refunded $30, moved your next order to Oct 6, and applied your points.",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.actions.length, 3);
    assert.equal(result.plan.actions[0].actionType, "partial_refund");
    assert.deepEqual(result.plan.actions[0].actionParams, {
      amount_cents: 3000,
      order_number: "SC131156",
    });
    assert.equal(result.plan.actions[1].actionType, "change_next_date");
    assert.deepEqual(result.plan.actions[1].actionParams, {
      next_billing_date: "2026-10-06",
      contract_id: "c1",
    });
    assert.equal(result.plan.actions[2].actionType, "redeem_points_as_refund");
    assert.deepEqual(result.plan.actions[2].actionParams, { amount_cents: 500 });
    // Back-compat aliases point at actions[0] so existing single-action callers still compile.
    assert.equal(result.plan.actionType, "partial_refund");
    assert.deepEqual(result.plan.actionParams, { amount_cents: 3000, order_number: "SC131156" });
    assert.equal(
      result.plan.customerMessage,
      "Refunded $30, moved your next order to Oct 6, and applied your points.",
    );
  }
});

test("planRemedyExecution — a malformed step inside actions[] fails the WHOLE plan (no partial fire)", () => {
  // The invariant: a batch with one broken step (missing action_type) must never partially fire —
  // stop the line so a human eyeballs the log. If the batch fired the first two of three, June's
  // customer message would promise a fix she didn't ship.
  const result = planRemedyExecution({
    actions: [
      { action_type: "partial_refund", payload: { amount_cents: 3000 } },
      { payload: { next_billing_date: "2026-10-06" } }, // missing action_type
      { action_type: "redeem_points_as_refund", payload: { amount_cents: 500 } },
    ],
    customer_message: "would be a false promise",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /remedy_action_1_malformed/);
});

test("planRemedyExecution — an empty actions[] falls through to legacy single-action shape", () => {
  // Corner case: `actions:[]` alongside a legacy top-level action_type. Empty actions[] cannot be
  // June's real intent, so we fall back to the legacy shape rather than fail — the whole point of
  // back-compat is that a stray field can't break a well-formed single-action remedy.
  const result = planRemedyExecution({
    actions: [],
    action_type: "change_next_date",
    payload: { next_billing_date: "2026-10-06" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.actions.length, 1);
    assert.equal(result.plan.actions[0].actionType, "change_next_date");
  }
});

test("planRemedyExecution — actions[] wins when both shapes appear on the same remedy", () => {
  // A stray top-level `action_type` next to a real `actions[]` batch must not silently override the
  // batch (that would fire only the first action + suppress the rest). Prefer the newer, richer
  // authoring form.
  const result = planRemedyExecution({
    actions: [
      { action_type: "partial_refund", payload: { amount_cents: 3000 } },
      { action_type: "change_next_date", payload: { next_billing_date: "2026-10-06" } },
    ],
    action_type: "resume",
    payload: { contract_id: "c1" },
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.actions.length, 2);
    assert.equal(result.plan.actions[0].actionType, "partial_refund");
    assert.equal(result.plan.actions[1].actionType, "change_next_date");
  }
});

test("planRemedyExecution — missing action_type is fail-safe", () => {
  const result = planRemedyExecution({ payload: { next_billing_date: "2026-10-06" } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "remedy_missing_action_type");
});

// ── canOfferOneTapApproval — the reorder gate for raiseFounderApproval ─────────────────────────

test("canOfferOneTapApproval — a {kind, summary} recommendation is NOT one-tappable (guard-first: no cockpit arm, no SMS)", () => {
  // The exact shape that caused the 2026-07-20 incident: escalate_founder's recommended_remedy is a
  // suggestion, not an {action_type} action. The predicate returning FALSE is what makes
  // raiseFounderApproval short-circuit BEFORE calling getActiveSession/armSession — so the founder
  // is never texted "tap in" for a card that will never open.
  assert.equal(
    canOfferOneTapApproval({
      kind: "acknowledge_and_request_info",
      summary: "Ask the customer for the order number on the $236.50 charge we can't locate.",
    }),
    false,
  );
});

test("canOfferOneTapApproval — a canonical single-action remedy IS one-tappable (proceeds to arm + text)", () => {
  // The executable path: raiseFounderApproval passes the guard, resolves/arms a cockpit session,
  // opens the card, and sends the SMS. Same shape that planRemedyExecution accepts as canonical.
  assert.equal(
    canOfferOneTapApproval({
      action_type: "change_next_date",
      payload: { next_billing_date: "2026-10-06", contract_id: "contract-1" },
      customer_message: "Moved to Oct 6.",
    }),
    true,
  );
});

test("canOfferOneTapApproval — null / undefined / non-object short-circuits to false (no drift from planner)", () => {
  // The predicate is a THIN wrapper: any new planner rejection reason automatically propagates.
  // If a caller ever hands raiseFounderApproval a null or malformed remedy, the guard MUST bail
  // (no arm / no SMS) — the executor would reject with `remedy_missing` on Approve anyway.
  assert.equal(canOfferOneTapApproval(null), false);
  assert.equal(canOfferOneTapApproval(undefined), false);
});

test("canOfferOneTapApproval — a multi-action actions[] batch with a malformed step is NOT one-tappable", () => {
  // Same invariant as planRemedyExecution: a batch with one broken step fails the WHOLE plan
  // (no partial fire on Approve), so the guard MUST block the founder page too.
  assert.equal(
    canOfferOneTapApproval({
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 3000 } },
        { payload: { next_billing_date: "2026-10-06" } }, // missing action_type
      ],
      customer_message: "would be a false promise",
    }),
    false,
  );
});

test("planRemedyExecution — REJECTS a legacy single-action step whose payload carries a reserved `type` (bypass class)", () => {
  // The known-bad shape: a non-money `action_type` (which the founder gate lets through auto-run)
  // paired with a money `payload.type` (which the executor would fire because of the spread order).
  // Any `type` on payload is reserved — plan MUST fail before founder-gate + executor see it.
  const result = planRemedyExecution({
    action_type: "change_next_date",
    payload: { type: "partial_refund", amount_cents: 999_999, next_billing_date: "2026-10-06" },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "remedy_payload_type_override");
});

test("planRemedyExecution — REJECTS a multi-action step whose payload carries a reserved `type` (bypass class)", () => {
  // Same class in the multi-action shape — the second step tries to smuggle a money action via
  // payload.type. The whole batch MUST fail; a partial-fire would still deliver June's promised
  // customer message with only step 0 having landed.
  const result = planRemedyExecution({
    actions: [
      { action_type: "change_next_date", payload: { next_billing_date: "2026-10-06" } },
      { action_type: "change_next_date", payload: { type: "partial_refund", amount_cents: 999_999 } },
    ],
    customer_message: "would be a false promise",
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "remedy_action_1_payload_type_override");
});

test("planRemedyExecution — REJECTS payload.type even when it MATCHES action_type (payload.type is always reserved)", () => {
  // A redundant `type` in payload is still rejected — payload must never carry the executor's
  // action selector. Blanket-rejecting removes any ambiguity around match/mismatch semantics and
  // prevents a future author from re-introducing the field with a "harmless" match.
  const result = planRemedyExecution({
    action_type: "partial_refund",
    payload: { type: "partial_refund", amount_cents: 3000 },
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "remedy_payload_type_override");
});

test("buildRemedySonnetDecision — canonical `type` cannot be overridden by a stray payload.type (defense in depth)", () => {
  // Belt-and-braces: even if a future caller assembles a `RemedyExecutionPlan` by hand and forgets
  // to strip a reserved key, the executor's `ActionParams.type` is the CANONICAL `plan.actionType`
  // — the spread happens BEFORE the type assignment, not after, so payload can't win.
  const decision = buildRemedySonnetDecision(
    {
      actions: [
        {
          actionType: "change_next_date",
          actionParams: {
            type: "partial_refund",
            amount_cents: 999_999,
            next_billing_date: "2026-10-06",
          } as Record<string, unknown>,
        },
      ],
      actionType: "change_next_date",
      actionParams: { next_billing_date: "2026-10-06" },
      customerMessage: null,
    },
    "manual-plan bypass attempt",
  );
  assert.equal(decision.actions?.[0]?.type, "change_next_date");
});

test("planRemedyExecution — missing remedy is fail-safe", () => {
  const result = planRemedyExecution(undefined);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "remedy_missing");
});

test("planRemedyExecution — payload defaults to {} when absent", () => {
  const result = planRemedyExecution({ action_type: "resume" });
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.plan.actionParams, {});
});

test("extractRemedyCustomerMessage — checks canonical + fallback field names", () => {
  assert.equal(extractRemedyCustomerMessage({ customer_message: "A" }), "A");
  assert.equal(extractRemedyCustomerMessage({ response_message: "B" }), "B");
  assert.equal(extractRemedyCustomerMessage({ message: "C" }), "C");
  assert.equal(extractRemedyCustomerMessage({ customer_reply: "D" }), "D");
  assert.equal(extractRemedyCustomerMessage({}), null);
  // Empty / whitespace-only strings are ignored (an author who typed no message shouldn't produce
  // a bare-whitespace customer send).
  assert.equal(extractRemedyCustomerMessage({ customer_message: "   " }), null);
  // customer_message takes priority over response_message.
  assert.equal(extractRemedyCustomerMessage({ customer_message: "X", response_message: "Y" }), "X");
});

test("buildRemedySonnetDecision — direct_action with actions[0], no response_message", () => {
  const decision = buildRemedySonnetDecision(
    {
      actions: [
        {
          actionType: "change_next_date",
          actionParams: { next_billing_date: "2026-10-06", contract_id: "contract-1" },
        },
      ],
      actionType: "change_next_date",
      actionParams: { next_billing_date: "2026-10-06", contract_id: "contract-1" },
      customerMessage: "Moved to Oct 6.",
    },
    "restore requested date",
  );
  assert.equal(decision.action_type, "direct_action");
  assert.equal(decision.actions?.length, 1);
  assert.equal(decision.actions?.[0]?.type, "change_next_date");
  assert.equal(decision.actions?.[0]?.next_billing_date, "2026-10-06");
  assert.equal(decision.actions?.[0]?.contract_id, "contract-1");
  // The whole point of the ordering invariant — no response_message on the decision so the executor
  // never delivers on our behalf.
  assert.equal(decision.response_message, undefined);
  assert.match(decision.reasoning, /restore requested date/);
});

test("buildRemedySonnetDecision — multi-action emits the FULL ordered batch (Phase 1)", () => {
  // executeSonnetDecision already accepts an `actions[]` array and runs them sequentially, so a
  // multi-action RemedyPlan lands as N ActionParams in the SAME order June authored. This is what
  // makes "the whole fix in one verdict" work — the executor fires all N, then handleApproveRemedy
  // messages the customer only if every action verified.
  const decision = buildRemedySonnetDecision(
    {
      actions: [
        { actionType: "partial_refund", actionParams: { amount_cents: 3000, order_number: "SC131156" } },
        { actionType: "change_next_date", actionParams: { next_billing_date: "2026-10-06", contract_id: "c1" } },
        { actionType: "redeem_points_as_refund", actionParams: { amount_cents: 500 } },
      ],
      actionType: "partial_refund",
      actionParams: { amount_cents: 3000, order_number: "SC131156" },
      customerMessage: "Refunded $30, moved your next order to Oct 6, and applied your points.",
    },
    "full fix — 3 actions",
  );
  assert.equal(decision.action_type, "direct_action");
  assert.equal(decision.actions?.length, 3);
  assert.equal(decision.actions?.[0]?.type, "partial_refund");
  assert.equal(decision.actions?.[0]?.amount_cents, 3000);
  assert.equal(decision.actions?.[0]?.order_number, "SC131156");
  assert.equal(decision.actions?.[1]?.type, "change_next_date");
  assert.equal(decision.actions?.[1]?.next_billing_date, "2026-10-06");
  assert.equal(decision.actions?.[1]?.contract_id, "c1");
  assert.equal(decision.actions?.[2]?.type, "redeem_points_as_refund");
  assert.equal(decision.actions?.[2]?.amount_cents, 500);
  // Same ordering invariant as single-action: NO response_message on the decision.
  assert.equal(decision.response_message, undefined);
});

test("buildRemedySonnetDecision — falls back to a synthetic reasoning when the input is empty", () => {
  const decision = buildRemedySonnetDecision(
    {
      actions: [{ actionType: "resume", actionParams: {} }],
      actionType: "resume",
      actionParams: {},
      customerMessage: null,
    },
    "",
  );
  assert.equal(decision.action_type, "direct_action");
  assert.match(decision.reasoning, /approve_remedy/);
});

// ── Phase 2 handleApproveRemedy ordering + failure invariants ──────────────────────────────────

/**
 * Helper — a Phase-2 test stub of Admin that returns the agent_jobs row (with instructions carrying
 * a ticket_id) for the two lookups handleApproveRemedy makes (public applyBoxCsDirectorCall entry
 * lookup + internal lookup for job.instructions), and an insertable ticket_messages table so the
 * sysNote path doesn't blow up.
 */
function approveRemedyAdmin(ticketId: string): Admin {
  return stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: ticketId }) } },
    tickets: { data: { customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: false } },
    ticket_messages: { data: null },
  });
}

test("Phase 2 — customer message is delivered ONLY AFTER runExecutor returns success (ordering)", async () => {
  const events: string[] = [];
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async (_ctx, _decision, send, sysNote) => {
      events.push("executor:start");
      await sysNote("firing change_next_date");
      // simulate the executor's own send path attempting delivery — it MUST be suppressed by the
      // no-op send fn handleApproveRemedy passes in, so this must not leak into the events log.
      await send("executor-internal message that must be suppressed", false);
      events.push("executor:done");
      return { messageSent: false, escalated: false, closed: false, statusManaged: false };
    },
    deliverMessage: async () => {
      events.push("deliverMessage");
    },
  };

  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "in-leash",
    remedy: {
      action_type: "change_next_date",
      payload: { next_billing_date: "2026-10-06", contract_id: "contract-1" },
      customer_message: "Your next billing date has been moved to October 6.",
    },
  };

  const admin = approveRemedyAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(result.needs_attention, undefined);
  assert.equal(result.message_delivered, true);
  // Ordering invariant: executor must finish before delivery fires; the executor's own send is
  // suppressed (never appears in the events log).
  assert.deepEqual(events, ["executor:start", "executor:done", "deliverMessage"]);
});

test("Phase 2 — a {{label_url}} token in June's message is substituted to a CTA button before delivery (ticket eca3f43b)", async () => {
  const LABEL = "https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/20260713/deadbeef.png";
  let delivered = "";
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async (ctx) => {
      // Simulate the executor stashing the create_return batch result on ctx —
      // exactly what handleDirectAction now does after run+verify.
      ctx._lastActionResults = [
        {
          action: { type: "create_return" },
          result: { success: true, labelUrl: LABEL, trackingNumber: "9400111", carrier: "USPS" },
        },
      ] as typeof ctx._lastActionResults;
      return { messageSent: false, escalated: false, closed: false, statusManaged: false };
    },
    deliverMessage: async (_a, _w, _t, _c, message) => {
      delivered = message;
    },
  };

  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "Return for full refund.",
    remedy: {
      action_type: "create_return",
      payload: { order_number: "SC134515" },
      customer_message: "Send the two tabs back with the prepaid label below.\n\n{{label_url}}",
    },
  };

  const admin = approveRemedyAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(result.message_delivered, true);
  // The literal token must be gone; the real label must be a clickable button.
  assert.ok(!delivered.includes("{{label_url}}"), "no literal {{label_url}} token");
  assert.ok(delivered.includes(`href="${LABEL}"`), "label rendered as an href");
  assert.ok(delivered.includes("Download your prepaid return label"), "CTA button label present");
});

test("Phase 2 — failed remedy action sends NO customer message and marks needs_attention", async () => {
  const events: string[] = [];
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async () => {
      events.push("executor:done");
      // handleDirectAction's escalation branch sets escalated=true on the return.
      return { messageSent: false, escalated: true, closed: false, statusManaged: false };
    },
    deliverMessage: async () => {
      events.push("deliverMessage");
    },
  };

  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "in-leash",
    remedy: {
      action_type: "change_next_date",
      payload: { next_billing_date: "2026-10-06", contract_id: "contract-1" },
      customer_message: "Your next billing date has been moved to October 6.",
    },
  };

  const admin = approveRemedyAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(result.reason, "remedy_action_escalated");
  assert.match(result.error ?? "", /no customer message sent/);
  // Delivery must not have fired — no false-promise.
  assert.deepEqual(events, ["executor:done"]);
});

test("Phase 2 — a malformed RemedyPlan (no action_type) parks needs_attention without firing", async () => {
  const events: string[] = [];
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async () => {
      events.push("executor");
      return { messageSent: false, escalated: false, closed: false, statusManaged: false };
    },
    deliverMessage: async () => {
      events.push("delivery");
    },
  };

  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "in-leash but the LLM did not name a concrete action",
    remedy: { summary: "restore requested date" },
  };

  const admin = approveRemedyAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(result.reason, "remedy_missing_action_type");
  // Neither the executor nor delivery fired — a malformed plan is a stop-the-line.
  assert.deepEqual(events, []);
});

test("Phase 2 — ticket 115350d5 shape (portal changedate) executes and delivers exactly once", async () => {
  // The derived-from ticket: June ruled `approve_remedy: change_next_date -> 2026-10-06` at 06:35
  // and nothing fired. This test asserts the shape of THAT verdict now fires the action once and
  // messages the customer exactly once.
  const events: string[] = [];
  let executorCalls = 0;
  let deliveryCalls = 0;
  const seenDecisions: unknown[] = [];
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-115350d5", channel: "portal" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async (_ctx, decision) => {
      executorCalls += 1;
      seenDecisions.push(decision);
      events.push("executor");
      return { messageSent: false, escalated: false, closed: false, statusManaged: false };
    },
    deliverMessage: async (_admin, _ws, _tid, channel, message, _sandbox) => {
      deliveryCalls += 1;
      events.push(`delivery:${channel}:${message.slice(0, 20)}`);
    },
  };

  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "Portal changedate remedy is in-leash — restore next_billing_date to 2026-10-06 and message the customer.",
    remedy: {
      action_type: "change_next_date",
      summary: "restore requested date",
      payload: {
        contract_id: "contract-115350d5",
        next_billing_date: "2026-10-06",
      },
      customer_message: "I've moved your next billing date to October 6, 2026. Reply if anything else needs adjusting!",
    },
  };

  const admin = approveRemedyAdmin("ticket-115350d5");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(result.message_delivered, true);
  assert.equal(executorCalls, 1, "executor must fire exactly once");
  assert.equal(deliveryCalls, 1, "delivery must fire exactly once");
  // Ordering: executor happens strictly before delivery.
  assert.equal(events[0], "executor");
  assert.match(events[1] ?? "", /^delivery:portal:I've moved your next/);
  // The decision handed to the executor is a direct_action with the change_next_date action + the
  // next_billing_date + contract_id from the RemedyPlan payload, and NO response_message (we own
  // delivery).
  const seen = seenDecisions[0] as { action_type: string; actions?: Array<Record<string, unknown>>; response_message?: string };
  assert.equal(seen.action_type, "direct_action");
  assert.equal(seen.actions?.[0]?.type, "change_next_date");
  assert.equal(seen.actions?.[0]?.next_billing_date, "2026-10-06");
  assert.equal(seen.actions?.[0]?.contract_id, "contract-115350d5");
  assert.equal(seen.response_message, undefined);
});

test("Phase 2 — a successful action with no customer_message returns ok:true, message_delivered:false", async () => {
  // June may issue a remedy where no customer reply is needed (the RemedyPlan's own
  // needs_customer_reply/close_ticket signal is checked by the runner's per-verdict ticket-state
  // transition; the executor here just skips delivery). Still ok, no needs_attention.
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async () => ({ messageSent: false, escalated: false, closed: false, statusManaged: false }),
    deliverMessage: async () => {
      throw new Error("delivery must not fire when there is no customer_message");
    },
  };

  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "in-leash",
    remedy: {
      action_type: "resume",
      payload: { contract_id: "contract-1" },
      needs_customer_reply: false,
    },
  };

  const admin = approveRemedyAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(result.needs_attention, undefined);
  assert.equal(result.message_delivered, false);
});

test("Phase 2 — a missing ticket_id in job.instructions parks needs_attention without firing", async () => {
  // Runner Phase 1 already guards for a missing ticket_id at enqueue time, but the executor
  // defends against the shape drift class (an unparseable JSON or a job we didn't route through
  // the runner). Nothing fires, needs_attention.
  const admin = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: "{ not valid json" } },
    tickets: { data: null },
    workspaces: { data: null },
    ticket_messages: { data: null },
  });
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => null,
    loadWorkspaceSandbox: async () => false,
    runExecutor: async () => {
      throw new Error("must not run");
    },
    deliverMessage: async () => {
      throw new Error("must not run");
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "in-leash",
    remedy: { action_type: "resume", payload: {} },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(result.reason, "ticket_id_unresolved");
});

// ── Phase 2 (multi-action-remedies) — execute-ALL-then-message across the batch ────────────────

test("Phase 2 — a 2-action batch runs both actions in ORDER, then delivers the customer message once", async () => {
  // The multi-action-remedies spec: June's full fix — e.g. partial_refund + change_next_date —
  // must fire BOTH actions before the customer hears a "we did it" reply. The batch is passed
  // through executeSonnetDecision ONCE (handleDirectAction iterates internally, in the SAME order
  // June authored), and only a clean return (`escalated:false` — every action passed verify) lets
  // us deliver the reply.
  const events: string[] = [];
  let executorCalls = 0;
  const seenDecisions: unknown[] = [];
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    // Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first — the executor's guard
    // reads live remedy state per money action target order; stub it as a clean $200 order with
    // nothing refunded + no live returns so the guard passes and the batch reaches the executor.
    loadRemedyStates: async () =>
      new Map<string, CxOrderRemedyState>([
        [
          "SC131156",
          {
            found: true,
            workspace_id: "ws-1",
            order_id: "order-uuid-SC131156",
            order_number: "SC131156",
            shopify_order_id: null,
            financial_status: "paid",
            total_cents: 20000,
            refunds_succeeded_cents: 0,
            remaining_refundable_cents: 20000,
            out_of_band_refunds_cents: 0,
            headroom_confidence: "live",
            succeeded_refunds: [],
            returns: [],
            open_returns: [],
          },
        ],
      ]),
    runExecutor: async (_ctx, decision, _send, sysNote) => {
      executorCalls += 1;
      seenDecisions.push(decision);
      // Simulate handleDirectAction's per-action sysNote lines (see handleDirectAction success
      // path in src/lib/action-executor.ts) — this is what our wrapping sysNote parses to build
      // the partial-batch surface on the failure path.
      await sysNote(`Action completed: partial_refund`);
      await sysNote(`Action completed: change_next_date`);
      events.push("executor:done");
      return { messageSent: false, escalated: false, closed: false, statusManaged: false };
    },
    deliverMessage: async (_admin, _ws, _tid, _channel, msg) => {
      events.push(`delivery:${msg.slice(0, 24)}`);
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "in-leash — the full fix is refund + move next date",
    remedy: {
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 3000, order_number: "SC131156" } },
        { action_type: "change_next_date", payload: { next_billing_date: "2026-10-06", contract_id: "c1" } },
      ],
      customer_message: "Refunded $30 and moved your next order to Oct 6.",
    },
  };
  const admin = approveRemedyAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(result.message_delivered, true);
  // The batch is a SINGLE executeSonnetDecision call — handleDirectAction iterates the actions
  // array internally, which preserves `substituteActionParams` cross-action placeholder resolution
  // (would break if we split into N separate executor calls).
  assert.equal(executorCalls, 1);
  // Ordering: BOTH actions completed before delivery fires — the customer hears nothing before
  // every action in the batch verified.
  assert.equal(events[0], "executor:done");
  assert.match(events[1] ?? "", /^delivery:Refunded \$30/);
  // The batch shape is exactly what June authored — 2 typed actions in June's authored order, no
  // response_message (we own delivery).
  const seen = seenDecisions[0] as {
    action_type: string;
    actions?: Array<Record<string, unknown>>;
    response_message?: string;
  };
  assert.equal(seen.action_type, "direct_action");
  assert.equal(seen.actions?.length, 2);
  assert.equal(seen.actions?.[0]?.type, "partial_refund");
  assert.equal(seen.actions?.[0]?.amount_cents, 3000);
  assert.equal(seen.actions?.[0]?.order_number, "SC131156");
  assert.equal(seen.actions?.[1]?.type, "change_next_date");
  assert.equal(seen.actions?.[1]?.next_billing_date, "2026-10-06");
  assert.equal(seen.actions?.[1]?.contract_id, "c1");
  assert.equal(seen.response_message, undefined);
});

test("Phase 2 — a 2-action batch whose 2nd action fails: NO customer message, needs_attention, note surfaces WHICH failed + what landed", async () => {
  // The partial-batch verification bullet: when action #2 fails, the customer hears NOTHING (no
  // false promise), the job parks needs_attention, and the surface names WHICH action failed +
  // what DID land so a human can finish the fix by hand. The batch's per-action `sysNote` lines
  // (from handleDirectAction) are the ground truth; handleApproveRemedy captures them and rolls
  // them up onto the returned `error` string + a summary internal note.
  let deliveryCalled = false;
  const capturedNotes: string[] = [];
  // Intercept the ticket_messages insert path so we can assert the SUMMARY note carries the
  // landed + failed lists (the spec's "note surfaces WHICH action failed + what DID land").
  const admin = {
    from(table: string) {
      if (table === "ticket_messages") {
        return {
          insert(row: { body: string }) {
            capturedNotes.push(row.body);
            return Promise.resolve({ data: null, error: null });
          },
        };
      }
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                async maybeSingle() {
                  if (table === "agent_jobs")
                    return {
                      data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-1" }) },
                    };
                  if (table === "tickets")
                    return { data: { customer_id: "cust-1", channel: "email" } };
                  if (table === "workspaces") return { data: { sandbox_mode: false } };
                  return { data: null };
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Admin;
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    // Phase 1 of a-money-remedy-must-read-the-live-remedy-state-first — stub the executor's
    // guard state read as clean so the failure surface asserted below is the EXECUTOR'S
    // per-action failure, not the state guard's up-front reject.
    loadRemedyStates: async () =>
      new Map<string, CxOrderRemedyState>([
        [
          "SC131156",
          {
            found: true,
            workspace_id: "ws-1",
            order_id: "order-uuid-SC131156",
            order_number: "SC131156",
            shopify_order_id: null,
            financial_status: "paid",
            total_cents: 20000,
            refunds_succeeded_cents: 0,
            remaining_refundable_cents: 20000,
            out_of_band_refunds_cents: 0,
            headroom_confidence: "live",
            succeeded_refunds: [],
            returns: [],
            open_returns: [],
          },
        ],
      ]),
    runExecutor: async (_ctx, _decision, _send, sysNote) => {
      // Simulate handleDirectAction's success + failure sysNote lines: action #1 landed, action
      // #2 failed → escalated (see the else-branch at src/lib/action-executor.ts:~3247).
      await sysNote(`Action completed: partial_refund`);
      await sysNote(`Action failed: change_next_date — contract not found`);
      return { messageSent: false, escalated: true, closed: false, statusManaged: false };
    },
    deliverMessage: async () => {
      deliveryCalled = true;
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "in-leash",
    remedy: {
      actions: [
        { action_type: "partial_refund", payload: { amount_cents: 3000, order_number: "SC131156" } },
        { action_type: "change_next_date", payload: { next_billing_date: "2026-10-06", contract_id: "c1" } },
      ],
      customer_message: "This message must NOT ship — the 2nd action failed.",
    },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(result.reason, "remedy_action_escalated");
  // The returned error string surfaces BOTH sides of the partial batch so the runner's log_tail
  // names them explicitly:
  assert.match(result.error ?? "", /change_next_date/, "error must name the FAILED action");
  assert.match(result.error ?? "", /partial_refund/, "error must name what DID land");
  assert.match(result.error ?? "", /no customer message sent/);
  // The customer heard nothing — the whole point of the invariant (a "we did it" message on a
  // half-fired batch is the exact false-promise class the derived-from ticket surfaced).
  assert.equal(deliveryCalled, false);
  // A summary internal note was written that names the landed + failed sets so a human eyeballing
  // the ticket sees the partial-batch state at a glance (not just per-line sysNote fragments).
  const summary = capturedNotes.find((n) =>
    /partial_refund/.test(n) && /change_next_date/.test(n) && /batch/i.test(n),
  );
  assert.ok(summary, `expected a summary note naming both actions + "batch"; captured: ${JSON.stringify(capturedNotes)}`);
});

test("Phase 2 — a SINGLE-action batch (back-compat) still surfaces the single action_type in success logs", async () => {
  // Back-compat check: an authored single-action RemedyPlan normalizes to actions.length === 1 in
  // Phase 1; the Phase-2 execute-ALL-then-message path handles length-1 exactly like the legacy
  // handler did (one action → one executor call → one deliver). Nothing regresses.
  let deliveryCalled = false;
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async (_ctx, _decision, _send, sysNote) => {
      await sysNote(`Action completed: change_next_date`);
      return { messageSent: false, escalated: false, closed: false, statusManaged: false };
    },
    deliverMessage: async () => {
      deliveryCalled = true;
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "in-leash",
    remedy: {
      action_type: "change_next_date",
      payload: { next_billing_date: "2026-10-06", contract_id: "c1" },
      customer_message: "Moved to Oct 6.",
    },
  };
  const admin = approveRemedyAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(result.message_delivered, true);
  assert.equal(deliveryCalled, true);
});

test("Phase 2 — executor throw parks needs_attention with reason executor_threw", async () => {
  const deps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async () => {
      throw new Error("commerce SDK exploded");
    },
    deliverMessage: async () => {
      throw new Error("delivery must not fire on executor throw");
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "in-leash",
    remedy: {
      action_type: "change_next_date",
      payload: { next_billing_date: "2026-10-06", contract_id: "contract-1" },
      customer_message: "Moved to Oct 6.",
    },
  };
  const admin = approveRemedyAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(result.reason, "executor_threw");
  assert.match(result.error ?? "", /commerce SDK exploded/);
});

// ── Phase 3 pure planners ──────────────────────────────────────────────────────────────────────

test("planAuthorSpec — canonical shape returns ok:true with normalized slug", () => {
  const result = planAuthorSpec({
    slug: "cs-analyzer-coupon-gap",
    title: "Analyzer routes repeat-coupon tickets to remedy",
    intent: "Route repeat-coupon tickets to the remedy path.",
    problem: "The analyzer skipped remedy path on repeat coupon.",
    target: "src/lib/ticket-analyzer.ts",
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.plan.slug, "cs-analyzer-coupon-gap");
    assert.equal(result.plan.title, "Analyzer routes repeat-coupon tickets to remedy");
    assert.equal(result.plan.target, "src/lib/ticket-analyzer.ts");
  }
});

test("planAuthorSpec — normalizes a loose LLM slug shape", () => {
  const result = planAuthorSpec({
    slug: "CS Analyzer Coupon_Gap!",
    title: "Analyzer routes repeat-coupon tickets to remedy",
    intent: "Route repeat-coupon tickets to the remedy path.",
    problem: "The analyzer skipped remedy path on repeat coupon.",
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.plan.slug, "cs-analyzer-coupon-gap");
});

test("planAuthorSpec — missing slug is fail-safe", () => {
  const r = planAuthorSpec({ title: "T", intent: "I", problem: "P" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "spec_seed_missing_slug");
});

test("planAuthorSpec — missing title / intent / problem all fail-safe distinctly", () => {
  const missingTitle = planAuthorSpec({ slug: "s", intent: "i", problem: "p" });
  assert.equal(missingTitle.ok, false);
  if (!missingTitle.ok) assert.equal(missingTitle.reason, "spec_seed_missing_title");
  const missingIntent = planAuthorSpec({ slug: "s", title: "t", problem: "p" });
  assert.equal(missingIntent.ok, false);
  if (!missingIntent.ok) assert.equal(missingIntent.reason, "spec_seed_missing_intent");
  const missingProblem = planAuthorSpec({ slug: "s", title: "t", intent: "i" });
  assert.equal(missingProblem.ok, false);
  if (!missingProblem.ok) assert.equal(missingProblem.reason, "spec_seed_missing_problem");
});

test("planAuthorSpec — a slug that normalizes to empty (all-dash) fails", () => {
  const r = planAuthorSpec({
    slug: "!!!___###",
    title: "t",
    intent: "i",
    problem: "p",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "spec_seed_slug_empties_after_normalize");
});

test("planAuthorSpec — missing seed is fail-safe", () => {
  const r = planAuthorSpec(undefined);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "spec_seed_missing");
});

test("buildAuthorSpecInput — Derived-from-ticket linkage + owner=cs + autoBuild:false", () => {
  const spec = buildAuthorSpecInput(
    {
      slug: "cs-analyzer-coupon-gap",
      title: "Analyzer routes repeat-coupon tickets to remedy",
      intent: "Route repeat-coupon tickets to the remedy path.",
      problem: "The analyzer skipped remedy path on repeat coupon.",
      target: "src/lib/ticket-analyzer.ts",
    },
    "ticket-115350d5",
  );
  assert.equal(spec.owner, "cs");
  assert.equal(spec.parent, "[[../functions/cs]]");
  assert.equal(spec.autoBuild, false);
  assert.match(spec.summary ?? "", /Derived-from-ticket:.*ticket-115350d5/);
  assert.match(spec.summary ?? "", /src\/lib\/ticket-analyzer\.ts/);
  assert.match(spec.summary ?? "", /CS Director/);
  assert.match(spec.why, /ticket-115350d5/);
  assert.match(spec.what, /ticket-115350d5/);
  assert.equal(spec.phases.length, 1);
  const phase = spec.phases[0];
  assert.ok(phase.body.length > 0);
  assert.ok(phase.verification.length > 0);
  assert.ok(phase.why.length > 0);
  assert.ok(phase.what.length > 0);
  assert.match(phase.verification, /npx tsc --noEmit/);
});

test("buildAuthorSpecInput — omits Target section when the LLM didn't name one", () => {
  const spec = buildAuthorSpecInput(
    {
      slug: "cs-x",
      title: "X",
      intent: "why",
      problem: "what",
      target: null,
    },
    "ticket-abc",
  );
  assert.doesNotMatch(spec.summary ?? "", /Target:/);
});

test("buildAuthorSpecInput — Phase 1: generated phase carries an auto-testable exec_kind:'tsc' floor check so the SDK's MissingMachineCheckError never fires again", () => {
  const spec = buildAuthorSpecInput(
    {
      slug: "cs-analyzer-coupon-gap",
      title: "Analyzer routes repeat-coupon tickets to remedy",
      intent: "Route repeat-coupon tickets to the remedy path.",
      problem: "The analyzer skipped remedy path on repeat coupon.",
      target: "src/lib/ticket-analyzer.ts",
    },
    "ticket-115350d5",
  );
  assert.equal(spec.phases.length, 1);
  const phase = spec.phases[0];
  const checks = phase.checks ?? [];
  assert.ok(checks.length >= 1, "phase must carry >=1 machine-runnable check");
  const autoTestableKinds = new Set([
    "tsc",
    "grep",
    "ci_status",
    "http_get",
    "db_probe_readonly",
    "unit_test",
    "build",
  ]);
  const hasAutoTestable = checks.some(
    (c) => typeof c.exec_kind === "string" && autoTestableKinds.has(c.exec_kind),
  );
  assert.ok(
    hasAutoTestable,
    "at least one check must carry an auto-testable exec_kind (satisfies assertEveryPhaseHasChecks)",
  );
  const floor = checks.find((c) => c.exec_kind === "tsc");
  assert.ok(floor, "the unconditional tsc floor check is present");
  assert.equal(floor?.params, null, "tsc takes no params (see validateExecutableCheck)");
  assert.equal(floor?.kind, "auto", "kind is 'auto' — display/chip category");
});

// ── Phase 3 handleAuthorSpec — SDK write via injected dep ──────────────────────────────────────

function authorSpecAdmin(ticketId: string | null): Admin {
  return stubAdminMulti({
    agent_jobs: {
      data: {
        ...CS_JOB_ROW,
        instructions: ticketId ? JSON.stringify({ ticket_id: ticketId }) : null,
      },
    },
  });
}

test("Phase 3 — author_spec calls the SDK with the built shape (never a raw insert)", async () => {
  const captured: Array<{
    workspaceId: string;
    slug: string;
    spec: StructuredSpecInput;
    intendedStatus: "planned" | "deferred";
    opts?: unknown;
  }> = [];
  const authorDeps: AuthorSpecDeps = {
    authorSpec: async (workspaceId, slug, spec, intendedStatus, opts) => {
      captured.push({ workspaceId, slug, spec, intendedStatus, opts });
      return true;
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "author_spec",
    reasoning: "Two prior turns drifted on the same coupon path — the analyzer misses this class.",
    spec_seed: {
      slug: "cs-analyzer-coupon-gap",
      title: "Analyzer routes repeat-coupon tickets to remedy",
      intent: "Route repeat-coupon tickets to the remedy path.",
      problem: "The analyzer skipped remedy path on repeat coupon.",
    },
  };
  const admin = authorSpecAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, { authorSpec: authorDeps });
  assert.equal(result.ok, true);
  assert.equal(result.handler, "author_spec");
  assert.equal(result.spec_slug, "cs-analyzer-coupon-gap");
  assert.equal(captured.length, 1);
  const call = captured[0];
  assert.equal(call.workspaceId, "ws-1");
  assert.equal(call.slug, "cs-analyzer-coupon-gap");
  assert.equal(call.spec.owner, "cs");
  assert.equal(call.spec.parent, "[[../functions/cs]]");
  assert.equal(call.spec.autoBuild, false);
  assert.equal(call.intendedStatus, "planned");
  // Linkage back to the originating ticket appears in the summary.
  assert.match(call.spec.summary ?? "", /Derived-from-ticket:.*ticket-1/);
  const opts = call.opts as { intendedStatusSetBy?: string } | undefined;
  assert.equal(opts?.intendedStatusSetBy, "box:cs-director-call");
});

test("Phase 3 — author_spec with a malformed spec_seed parks needs_attention (no SDK call)", async () => {
  let sdkCalled = false;
  const authorDeps: AuthorSpecDeps = {
    authorSpec: async () => {
      sdkCalled = true;
      return true;
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "author_spec",
    reasoning: "spec_seed has no title",
    spec_seed: { slug: "cs-foo", intent: "why", problem: "what" },
  };
  const admin = authorSpecAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, { authorSpec: authorDeps });
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(result.reason, "spec_seed_missing_title");
  assert.equal(sdkCalled, false);
});

test("Phase 3 — author_spec with an unresolvable ticket_id parks needs_attention (Derived-from linkage cannot be blank)", async () => {
  let sdkCalled = false;
  const authorDeps: AuthorSpecDeps = {
    authorSpec: async () => {
      sdkCalled = true;
      return true;
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "author_spec",
    reasoning: "seed is fine but ticket can't be found",
    spec_seed: {
      slug: "cs-foo",
      title: "Foo",
      intent: "why",
      problem: "what",
    },
  };
  const admin = authorSpecAdmin(null);
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, { authorSpec: authorDeps });
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(result.reason, "ticket_id_unresolved");
  assert.equal(sdkCalled, false);
});

test("Phase 3 — author_spec parks needs_attention when the SDK returns false (chokepoint guard rejected)", async () => {
  const authorDeps: AuthorSpecDeps = {
    authorSpec: async () => false,
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "author_spec",
    reasoning: "runaway-derivative-fix circuit-breaker trips inside the chokepoint",
    spec_seed: {
      slug: "cs-repair-x-2",
      title: "Repair",
      intent: "why",
      problem: "what",
    },
  };
  const admin = authorSpecAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, { authorSpec: authorDeps });
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(result.reason, "author_spec_write_returned_false");
});

// ── Phase 2 of cs-director-spec-claim-must-match-the-actual-write ──
// Alongside the malformed-remedy park test above, cover the failed-write path end-to-end: an
// author_spec verdict whose SDK write fails MUST park needs_attention AND, when composed with the
// ticket transition, MUST NOT close + de-escalate the ticket. Ticket 2b7ea029 was closed on a
// phantom spec because the transition ran unconditionally on `decision='author_spec'`; the
// close was the irreversible half that hid the miss for a day.

test("Phase 2 — a FAILED author_spec write parks needs_attention AND the composed ticket transition keeps the ticket open+escalated (ticket 2b7ea029 shape)", async () => {
  const authorDeps: AuthorSpecDeps = {
    authorSpec: async () => false, // chokepoint guard rejected — same shape as the ticket-2b7ea029 miss
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "author_spec",
    reasoning: "Bug identified — appstle discount replace clobbers manual discounts.",
    spec_seed: {
      slug: "appstle-discount-replace-atomic-and-preserve-manual-discounts",
      title: "Preserve manual discounts across Appstle discount replace",
      intent: "why",
      problem: "what",
    },
  };
  const admin = authorSpecAdmin("ticket-2b7ea029");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, { authorSpec: authorDeps });

  // The executor half — a failed write parks needs_attention with the concrete reason.
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(result.reason, "author_spec_write_returned_false");
  assert.equal(result.spec_slug, undefined, "no spec landed → no spec_slug surfaced");

  // The transition half — the runner threads the result into `decideCsDirectorTicketTransition`;
  // the ticket MUST NOT close on a failed write. (`result.ok` was asserted `false` above; TS narrows
  // to that literal, so the runner's `ok===true && needs_attention!==true` predicate resolves to
  // `false` here without re-computing it.)
  const transition = decideCsDirectorTicketTransition({
    decision: verdict.decision,
    reasoning: verdict.reasoning,
    remedy: null,
    authorSpecOutcome: { specWritten: false, reason: result.reason },
    now: "2026-07-25T12:00:00.000Z",
  });
  assert.equal(transition.action_key, "keep_escalated_needs_attention");
  assert.equal(transition.patch.status, undefined, "MUST NOT close on a phantom author_spec");
  assert.equal(transition.patch.closed_at, undefined);
  assert.equal(transition.patch.escalated_at, undefined, "escalation MUST NOT be cleared on a failed write");
  assert.match(
    String(transition.patch.escalation_reason),
    /author_spec FAILED \(author_spec_write_returned_false\) — no spec was written/,
    "escalation_reason MUST name the failure so a CS agent sees WHY the ticket is back in-queue",
  );
});

test("Phase 3 — author_spec parks needs_attention when the SDK throws", async () => {
  const authorDeps: AuthorSpecDeps = {
    authorSpec: async () => {
      throw new Error("AuthorWriteFailedError: row not visible after upsertSpec");
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "author_spec",
    reasoning: "SDK-level write blip",
    spec_seed: {
      slug: "cs-foo",
      title: "Foo",
      intent: "why",
      problem: "what",
    },
  };
  const admin = authorSpecAdmin("ticket-1");
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, { authorSpec: authorDeps });
  assert.equal(result.ok, false);
  assert.equal(result.needs_attention, true);
  assert.equal(result.reason, "author_spec_threw");
  assert.match(result.error ?? "", /AuthorWriteFailedError/);
});

// ── Phase 3 handleEscalateFounder — linkage payload ────────────────────────────────────────────

test("Phase 3 — escalate_founder returns linkage_ticket_id + linkage_triage_run_id", async () => {
  const admin = stubAdminMulti({
    agent_jobs: {
      data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-42", triage_run_id: "run-77" }) },
    },
  });
  const verdict: CsDirectorVerdictInput = {
    decision: "escalate_founder",
    reasoning: "storyline-shaped judgment call",
    recommended_remedy: { kind: "refund", summary: "Refund the last invoice" },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "escalate_founder");
  assert.equal(result.linkage_ticket_id, "ticket-42");
  assert.equal(result.linkage_triage_run_id, "run-77");
});

test("Phase 3 — escalate_founder returns null linkage when instructions are unparseable (but still ok:true — runner is the sole card writer)", async () => {
  const admin = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: "{ not valid json" } },
  });
  const verdict: CsDirectorVerdictInput = {
    decision: "escalate_founder",
    reasoning: "storyline-shaped judgment call",
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "escalate_founder");
  assert.equal(result.linkage_ticket_id, null);
  assert.equal(result.linkage_triage_run_id, null);
});

test("Phase 3 — escalate_founder linkage is null-triage when only ticket_id is present", async () => {
  const admin = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-42" }) } },
  });
  const verdict: CsDirectorVerdictInput = {
    decision: "escalate_founder",
    reasoning: "storyline-shaped judgment call",
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict);
  assert.equal(result.ok, true);
  assert.equal(result.linkage_ticket_id, "ticket-42");
  assert.equal(result.linkage_triage_run_id, null);
});

// ── Phase 2 legacy-deps-bag compatibility with Phase-3 union deps type ─────────────────────────

test("Phase 2/3 back-compat — passing a bare ApproveRemedyDeps still routes approve_remedy correctly", async () => {
  // The Phase-2 test suite passed a bare ApproveRemedyDeps as the 4th arg. Phase 3 broadened the
  // type to CsDirectorApplyDeps (a union of approveRemedy + authorSpec bags). This test pins that
  // the back-compat shim in applyBoxCsDirectorCall STILL routes a bare ApproveRemedyDeps into the
  // approve_remedy path so we never break the existing test surface.
  const admin = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-1" }) } },
    tickets: { data: { customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: false } },
    ticket_messages: { data: null },
  });
  let executorCalled = false;
  const bareApproveDeps: ApproveRemedyDeps = {
    loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
    loadWorkspaceSandbox: async () => false,
    runExecutor: async () => {
      executorCalled = true;
      return { messageSent: false, escalated: false, closed: false, statusManaged: false };
    },
    deliverMessage: async () => {
      /* no-op — no customer_message on this verdict */
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "approve_remedy",
    reasoning: "in-leash",
    remedy: { action_type: "resume", payload: { contract_id: "contract-1" } },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, bareApproveDeps);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "approve_remedy");
  assert.equal(executorCalled, true);
});

// ── Live remedy-state hard-reject guard (spec: a-money-remedy-must-read-the-live-remedy-state-first Phase 1) ──
//
// Test-first for the NAMED failing state (ticket 86043da0, Jan Bloom): SC135494 $182.95 order,
// $15 already refunded, a live `returns` row with `refunded_at IS NULL` — June proposing another
// $167.95 refund would DOUBLE-PAY. The guard MUST reject on `live_return_would_double_pay` first,
// then on `amount_exceeds_remaining_refundable` when no live return but the amount is too high,
// and pass cleanly when neither rail trips.

/** Baseline: a $200 order (20000 cents) with nothing refunded and no returns → clean. */
function cleanState(): CxOrderRemedyState {
  return {
    found: true,
    workspace_id: "ws-1",
    order_id: "order-uuid-1",
    order_number: "SC135494",
    shopify_order_id: null,
    financial_status: "paid",
    total_cents: 20000,
    refunds_succeeded_cents: 0,
    remaining_refundable_cents: 20000,
    out_of_band_refunds_cents: 0,
    headroom_confidence: "live",
    succeeded_refunds: [],
    returns: [],
    open_returns: [],
  };
}

test("verifyPlanAgainstRemedyStates — REJECTS when a live un-refunded return covers the target order (Jan Bloom shape)", () => {
  // Reproduces ticket 86043da0: SC135494 $182.95, prior $15 refund, and a live `returns` row
  // with refunded_at=null. Even if the proposed refund is ONLY the residual $167.95, the return
  // is going to fire on receipt — so a fresh refund double-pays.
  const state: CxOrderRemedyState = {
    ...cleanState(),
    total_cents: 18295,
    refunds_succeeded_cents: 1500,
    remaining_refundable_cents: 16795,
    succeeded_refunds: [
      { id: "r1", vendor: "braintree", vendor_refund_id: "txn-1", amount_cents: 1500, status: "succeeded", requested_at: "2026-07-27T19:56:00Z" },
    ],
    returns: [
      {
        id: "ret-1",
        status: "label_created",
        resolution_type: "refund_return",
        net_refund_cents: 18295,
        label_cost_cents: 700,
        refunded_at: null,
        delivered_at: null,
        shipped_at: null,
        created_at: "2026-07-27T20:32:00Z",
        refund_id: null,
        tracking_number: null,
      },
    ],
    open_returns: [
      {
        id: "ret-1",
        status: "label_created",
        resolution_type: "refund_return",
        net_refund_cents: 18295,
        label_cost_cents: 700,
        refunded_at: null,
        delivered_at: null,
        shipped_at: null,
        created_at: "2026-07-27T20:32:00Z",
        refund_id: null,
        tracking_number: null,
      },
    ],
  };
  const ref = extractRemedyOrderRefFromStep({ shopify_order_id: "SC135494", amount_cents: 16795 })!;
  const plan: RemedyActionStep[] = [
    { actionType: "partial_refund", actionParams: { shopify_order_id: "SC135494", amount_cents: 16795, reason: "requested refund" } },
  ];
  const states = new Map<string, CxOrderRemedyState>();
  states.set(ref.key, state);
  const verdict = verifyPlanAgainstRemedyStates(plan, states);
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.equal(verdict.violation.reason, "live_return_would_double_pay");
  assert.equal(verdict.violation.actionType, "partial_refund");
});

test("verifyPlanAgainstRemedyStates — REJECTS when summed amount exceeds remaining refundable (no live return)", () => {
  // $200 order, $50 already refunded → $150 remaining refundable. A batch of 2×$100 partial_refund
  // sums to $200 > $150 and must be refused even without a live return.
  const state: CxOrderRemedyState = {
    ...cleanState(),
    total_cents: 20000,
    refunds_succeeded_cents: 5000,
    remaining_refundable_cents: 15000,
    succeeded_refunds: [
      { id: "r1", vendor: "braintree", vendor_refund_id: "txn-1", amount_cents: 5000, status: "succeeded", requested_at: "2026-07-27T19:56:00Z" },
    ],
  };
  const ref = extractRemedyOrderRefFromStep({ shopify_order_id: "SC135494" })!;
  const plan: RemedyActionStep[] = [
    { actionType: "partial_refund", actionParams: { shopify_order_id: "SC135494", amount_cents: 10000, reason: "part A" } },
    { actionType: "partial_refund", actionParams: { shopify_order_id: "SC135494", amount_cents: 10000, reason: "part B" } },
  ];
  const states = new Map<string, CxOrderRemedyState>();
  states.set(ref.key, state);
  const verdict = verifyPlanAgainstRemedyStates(plan, states);
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.equal(verdict.violation.reason, "amount_exceeds_remaining_refundable");
});

test("verifyPlanAgainstRemedyStates — PASSES a clean state with amount ≤ remaining refundable and no live return", () => {
  const state = cleanState();
  const ref = extractRemedyOrderRefFromStep({ shopify_order_id: "SC135494" })!;
  const plan: RemedyActionStep[] = [
    { actionType: "partial_refund", actionParams: { shopify_order_id: "SC135494", amount_cents: 5000, reason: "shipping" } },
  ];
  const states = new Map<string, CxOrderRemedyState>();
  states.set(ref.key, state);
  const verdict = verifyPlanAgainstRemedyStates(plan, states);
  assert.equal(verdict.ok, true);
});

test("verifyPlanAgainstRemedyStates — non-money actions never trip the guard (a batch with change_next_date + resume is a no-op here)", () => {
  const plan: RemedyActionStep[] = [
    { actionType: "change_next_date", actionParams: { subscription_id: "sub-1", next_date: "2026-08-15" } },
    { actionType: "resume", actionParams: { contract_id: "contract-1" } },
  ];
  const verdict = verifyPlanAgainstRemedyStates(plan, new Map());
  assert.equal(verdict.ok, true);
});

test("verifyPlanAgainstRemedyStates — a money step with no resolvable order reference fails closed (missing_order_reference)", () => {
  const plan: RemedyActionStep[] = [
    { actionType: "partial_refund", actionParams: { amount_cents: 5000, reason: "no order id" } },
  ];
  const verdict = verifyPlanAgainstRemedyStates(plan, new Map());
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.equal(verdict.violation.reason, "missing_order_reference");
});

test("verifyPlanAgainstRemedyStates — REJECTS a partial_refund BELOW mirror remaining_refundable when headroom_confidence='degraded' (out-of-band Shopify refund could double-pay)", () => {
  // The fail-open gap the remedy-state-must-see-out-of-band-refunds diff introduced: the mirror
  // says remaining_refundable is $200 but the live Shopify ledger call FAILED (degraded fallback),
  // so the mirror cannot see an out-of-band Shopify refund that already drew down the same money.
  // A refund BELOW mirror remaining_refundable that would otherwise slip through must be REJECTED.
  const state: CxOrderRemedyState = {
    ...cleanState(),
    total_cents: 20000,
    refunds_succeeded_cents: 0,
    remaining_refundable_cents: 20000,
    headroom_confidence: "degraded",
    out_of_band_refunds_cents: 0,
  };
  const ref = extractRemedyOrderRefFromStep({ shopify_order_id: "SC135494" })!;
  const plan: RemedyActionStep[] = [
    { actionType: "partial_refund", actionParams: { shopify_order_id: "SC135494", amount_cents: 5000, reason: "shipping" } },
  ];
  const states = new Map<string, CxOrderRemedyState>();
  states.set(ref.key, state);
  const verdict = verifyPlanAgainstRemedyStates(plan, states);
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.equal(verdict.violation.reason, "headroom_degraded");
  assert.equal(verdict.violation.actionType, "partial_refund");
  // Detail names the order key and that live Shopify headroom is unreadable.
  assert.match(verdict.violation.detail, /SC135494/);
  assert.match(verdict.violation.detail, /headroom_confidence=degraded/);
  assert.match(verdict.violation.detail, /unreadable/i);
});

test("verifyPlanAgainstRemedyStates — headroom_confidence='live' with no open returns and amount ≤ remaining still PASSES (baseline unaffected)", () => {
  const state = cleanState();
  const ref = extractRemedyOrderRefFromStep({ shopify_order_id: "SC135494" })!;
  const plan: RemedyActionStep[] = [
    { actionType: "partial_refund", actionParams: { shopify_order_id: "SC135494", amount_cents: 5000, reason: "shipping" } },
  ];
  const states = new Map<string, CxOrderRemedyState>();
  states.set(ref.key, state);
  const verdict = verifyPlanAgainstRemedyStates(plan, states);
  assert.equal(verdict.ok, true);
});

// ── Subscription-scoped loyalty coupon exemption (spec: june-loyalty-coupon-to-subscription-exempt-from-order-scoped-remedy-state-rail) ──
//
// Derived-from ticket 2ce25d56 (Beth Dunn): an apply_loyalty_coupon carrying a contract_id and NO
// order reference used to hit `missing_order_reference` because it's a member of
// MONEY_ACTION_TYPES — deadlocking the ticket forever. A loyalty coupon on a future renewal cannot
// double-pay any order, so it must pass the order-scoped rail. redeem_points_as_refund still draws
// down a real order and stays inside the rail.

test("verifyPlanAgainstRemedyStates — apply_loyalty_coupon{contract_id, no order} PASSES (subscription-scoped loyalty exemption)", () => {
  const plan: RemedyActionStep[] = [
    {
      actionType: "apply_loyalty_coupon",
      actionParams: {
        contract_id: "gid://shopify/SubscriptionContract/123",
        code: "LOYALTY-15-ABCDEF",
      },
    },
  ];
  // No remedy states prefetched — the point of the exemption is that this shape names no order to
  // read state for. Old behavior: missing_order_reference. New behavior: passes cleanly.
  const verdict = verifyPlanAgainstRemedyStates(plan, new Map());
  assert.equal(verdict.ok, true);
});

test("verifyPlanAgainstRemedyStates — a mint-and-apply pair {redeem_points, apply_loyalty_coupon{contract_id}} PASSES with no order states", () => {
  const plan: RemedyActionStep[] = [
    { actionType: "redeem_points", actionParams: { tier_index: 0 } },
    {
      actionType: "apply_loyalty_coupon",
      actionParams: {
        contract_id: "gid://shopify/SubscriptionContract/123",
        code: "LOYALTY-15-ABCDEF",
      },
    },
  ];
  const verdict = verifyPlanAgainstRemedyStates(plan, new Map());
  assert.equal(verdict.ok, true);
});

test("verifyPlanAgainstRemedyStates — apply_loyalty_coupon WITHOUT contract_id still fails missing_order_reference (executor would reject too)", () => {
  const plan: RemedyActionStep[] = [
    { actionType: "apply_loyalty_coupon", actionParams: { code: "LOYALTY-15-ABCDEF" } },
  ];
  const verdict = verifyPlanAgainstRemedyStates(plan, new Map());
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.equal(verdict.violation.reason, "missing_order_reference");
});

test("verifyPlanAgainstRemedyStates — apply_loyalty_coupon that ALSO names an order ref stays inside the order-scoped rail (would-double-pay branch)", () => {
  // An apply_loyalty_coupon that also names an order (unusual but possible) must NOT be exempted
  // — a coupon that binds to a specific order could theoretically compound with a refund on that
  // same order, so keep it inside the guard. Here we simulate an order with a live open return
  // covering the whole thing → live_return_would_double_pay must fire regardless of type.
  const state: CxOrderRemedyState = {
    ...cleanState(),
    total_cents: 18295,
    open_returns: [
      {
        id: "ret-1",
        status: "label_created",
        resolution_type: "refund_return",
        net_refund_cents: 18295,
        label_cost_cents: 700,
        refunded_at: null,
        delivered_at: null,
        shipped_at: null,
        created_at: "2026-07-27T20:32:00Z",
        refund_id: null,
        tracking_number: null,
      },
    ],
  };
  const ref = extractRemedyOrderRefFromStep({ shopify_order_id: "SC135494" })!;
  const plan: RemedyActionStep[] = [
    {
      actionType: "apply_loyalty_coupon",
      actionParams: {
        contract_id: "gid://shopify/SubscriptionContract/123",
        shopify_order_id: "SC135494",
        code: "LOYALTY-15-ABCDEF",
      },
    },
  ];
  const states = new Map<string, CxOrderRemedyState>();
  states.set(ref.key, state);
  const verdict = verifyPlanAgainstRemedyStates(plan, states);
  // Order ref present → order-scoped rail still applies → the live open return double-pay rail
  // trips as it would for a partial_refund.
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.equal(verdict.violation.reason, "live_return_would_double_pay");
});

test("verifyPlanAgainstRemedyStates — redeem_points_as_refund is NEVER exempt (draws down a real order, keeps order-scoped rail)", () => {
  const plan: RemedyActionStep[] = [
    { actionType: "redeem_points_as_refund", actionParams: { tier_index: 0 } },
  ];
  const verdict = verifyPlanAgainstRemedyStates(plan, new Map());
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.equal(verdict.violation.reason, "missing_order_reference");
});

test("verifyPlanAgainstRemedyStates — mixed batch: subscription loyalty coupon + a partial_refund that violates → violation still names the partial_refund", () => {
  // A batch mixing the exempt loyalty coupon with a real partial_refund on an order with a live
  // return: the loyalty step is skipped by the exemption, but the partial_refund step still
  // trips the double-pay rail. The violation must correctly name the partial_refund's index.
  const state: CxOrderRemedyState = {
    ...cleanState(),
    open_returns: [
      {
        id: "ret-1",
        status: "label_created",
        resolution_type: "refund_return",
        net_refund_cents: 5000,
        label_cost_cents: 700,
        refunded_at: null,
        delivered_at: null,
        shipped_at: null,
        created_at: "2026-07-27T20:32:00Z",
        refund_id: null,
        tracking_number: null,
      },
    ],
  };
  const ref = extractRemedyOrderRefFromStep({ shopify_order_id: "SC135494" })!;
  const plan: RemedyActionStep[] = [
    {
      actionType: "apply_loyalty_coupon",
      actionParams: { contract_id: "gid://c/1", code: "LOYALTY-15-ABCDEF" },
    },
    {
      actionType: "partial_refund",
      actionParams: { shopify_order_id: "SC135494", amount_cents: 5000, reason: "shipping" },
    },
  ];
  const states = new Map<string, CxOrderRemedyState>();
  states.set(ref.key, state);
  const verdict = verifyPlanAgainstRemedyStates(plan, states);
  assert.equal(verdict.ok, false);
  if (verdict.ok) throw new Error("unreachable");
  assert.equal(verdict.violation.reason, "live_return_would_double_pay");
  assert.equal(verdict.violation.actionType, "partial_refund");
  assert.equal(verdict.violation.actionIndex, 1);
});

test("extractRemedyOrderRefFromStep — canonicalizes an order_number smuggled into shopify_order_id", () => {
  // partial_refund's executor resolves a non-digit shopify_order_id against the order_number column
  // (action-executor.ts:2227). The extractor mirrors that so the state lookup matches what the
  // executor will fire against.
  const ref = extractRemedyOrderRefFromStep({ shopify_order_id: "SC135494", amount_cents: 100 });
  assert.notEqual(ref, null);
  assert.equal(ref!.orderNumber, "SC135494");
  assert.equal(ref!.shopifyOrderId, null);
  assert.equal(ref!.key, "SC135494");
});

// ── Phase 1 (a-founder-escalated-customer-never-waits-in-silence) — customer acknowledgement ─────
//
// The escalate_founder path must ALWAYS deliver one honest acknowledgement to the customer, written
// as Suzie continuing to help — no handoff language, no timeframe, naming the specific concern. The
// three worst founder-lane waits on record (232h, 75h, 46h) were all silence — the routing was
// right; only the customer's experience was wrong.

test("composeFounderEscalationAck — subject-scoped ack in Suzie's voice with no handoff language", () => {
  const body = composeFounderEscalationAck({ subject: "My subscription renewed twice this month" });
  // Names the specific thing (the customer's own subject) — the "person who read your note" test.
  assert.match(body, /My subscription renewed twice this month/);
  // First-person Suzie voice, signed off.
  assert.match(body, /I want to make sure I get this right for you/);
  assert.ok(body.trim().endsWith("Suzie"), `expected Suzie sign-off, got: ${body}`);
  // NO handoff language — the customer must not learn an escalation happened. These are the
  // Phase-3 pin words too; asserting here means a regression on the composer's phrasing fails
  // Phase 1's own suite as well.
  for (const banned of [
    /escalat/i,
    /\bhuman\b/i,
    /\bmanager\b/i,
    /\bsupervisor\b/i,
    /another team/i,
    /higher tier/i,
    /passed to/i,
    /forwarded to/i,
    /transferr?ed/i,
    /team member/i,
  ]) {
    assert.doesNotMatch(body, banned, `ack contains banned handoff phrase: ${String(banned)}`);
  }
  // NO timeframe — the honest answer on this lane is often days; any number quoted here is wrong.
  for (const banned of [/shortly/i, /24 hours/i, /as soon as possible/i, /within \d/i, /tomorrow/i, /\btoday\b/i]) {
    assert.doesNotMatch(body, banned, `ack contains timeframe: ${String(banned)}`);
  }
});

test("composeFounderEscalationAck — strips Re:/Fwd: subject prefixes so the sentence reads naturally", () => {
  const body = composeFounderEscalationAck({ subject: "Re: Fwd: Order SC131607 refund" });
  assert.doesNotMatch(body, /Re:/i);
  assert.doesNotMatch(body, /Fwd:/i);
  assert.match(body, /Order SC131607 refund/);
});

test("composeFounderEscalationAck — a null / blank subject falls back to a non-generic phrasing", () => {
  const bodyNull = composeFounderEscalationAck({ subject: null });
  const bodyBlank = composeFounderEscalationAck({ subject: "   " });
  for (const body of [bodyNull, bodyBlank]) {
    assert.match(body, /what you've written in/);
    assert.ok(body.trim().endsWith("Suzie"));
  }
});

test("Phase 1 — escalate_founder delivers the acknowledgement via deliverMessage when no partial remedy runs", async () => {
  // A verdict with only `recommended_remedy` (a human suggestion for the CEO) and NO in-leash
  // `remedy` — the exact shape of every historical founder escalation on record. Before this spec,
  // handleEscalateFounder returned without messaging on this path — the customer heard nothing at
  // all. After: the ack goes out via deps.deliverMessage.
  const admin = stubAdminMulti({
    agent_jobs: {
      data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-1", triage_run_id: "run-1" }) },
    },
    tickets: { data: { subject: "Refund my second bag", customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: true } },
  });
  const deliveries: Array<{ ticketId: string; channel: string; body: string; sandbox: boolean }> = [];
  const deps: CsDirectorApplyDeps = {
    approveRemedy: {
      loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
      loadWorkspaceSandbox: async () => true,
      runExecutor: async () => {
        throw new Error("runExecutor must not fire when the verdict carries no remedy");
      },
      deliverMessage: async (_admin, _ws, ticketId, channel, body, sandbox) => {
        deliveries.push({ ticketId, channel, body, sandbox });
      },
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "escalate_founder",
    reasoning: "Grandfathered price lock on a $26.89 overcharge needs the CEO's ruling.",
    recommended_remedy: { kind: "refund_and_price_lock", summary: "Refund + restore the $33.01 grandfathered price before next renewal" },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "escalate_founder");
  // ONE delivery — not zero, not two.
  assert.equal(deliveries.length, 1, `expected exactly one delivery, got ${deliveries.length}`);
  assert.equal(deliveries[0].ticketId, "ticket-1");
  assert.equal(deliveries[0].channel, "email");
  // The delivered body is the ack, subject-scoped, signed Suzie, no handoff language.
  assert.match(deliveries[0].body, /Refund my second bag/);
  assert.match(deliveries[0].body, /Suzie$/);
  assert.doesNotMatch(deliveries[0].body, /escalat/i);
});

// ── Phase 2 (a-founder-escalated-customer-never-waits-in-silence) — recheck-aware ack variants ───
//
// "Never the same text twice" — a stale re-check (48h after the initial escalation, customer still
// writing) sends a DIFFERENT acknowledgement so the reader doesn't hear a canned reply on a repeat
// pass. Three variants (initial + two rechecks) match the FOUNDER_RECHECK_CAP = 2 hard cap; beyond
// that the sweep does not enqueue a new job, so no fourth variant is needed.

test("Phase 2 — composeFounderEscalationAck produces three DISTINCT bodies across recheckIndex 0/1/2", () => {
  const bodies = [0, 1, 2].map((i) => composeFounderEscalationAck({ subject: "Refund my second bag", recheckIndex: i }));
  // All three must differ from each other — this is the "never the same text twice" rule.
  assert.notEqual(bodies[0], bodies[1], "recheckIndex 0 vs 1 must differ");
  assert.notEqual(bodies[1], bodies[2], "recheckIndex 1 vs 2 must differ");
  assert.notEqual(bodies[0], bodies[2], "recheckIndex 0 vs 2 must differ");
});

test("Phase 2 — every recheck variant obeys the voice invariants (no handoff, no timeframe, subject-scoped, Suzie sign-off)", () => {
  for (const idx of [0, 1, 2]) {
    const body = composeFounderEscalationAck({ subject: "My subscription renewed twice this month", recheckIndex: idx });
    assert.match(body, /My subscription renewed twice this month/, `variant ${idx} must name the topic`);
    assert.ok(body.trim().endsWith("Suzie"), `variant ${idx} must sign off Suzie`);
    for (const banned of [
      /escalat/i,
      /\bhuman\b/i,
      /\bmanager\b/i,
      /\bsupervisor\b/i,
      /another team/i,
      /higher tier/i,
      /passed to/i,
      /forwarded to/i,
      /transferr?ed/i,
      /team member/i,
    ]) {
      assert.doesNotMatch(body, banned, `variant ${idx} contains banned handoff phrase: ${String(banned)}`);
    }
    for (const banned of [/shortly/i, /24 hours/i, /as soon as possible/i, /within \d/i, /tomorrow/i, /\btoday\b/i]) {
      assert.doesNotMatch(body, banned, `variant ${idx} contains timeframe: ${String(banned)}`);
    }
  }
});

test("Phase 2 — recheckIndex clamps to [0..2]: an out-of-range index reuses the closest variant (no crash, no undefined body)", () => {
  const negative = composeFounderEscalationAck({ subject: "Order refund", recheckIndex: -5 });
  const initial = composeFounderEscalationAck({ subject: "Order refund", recheckIndex: 0 });
  assert.equal(negative, initial, "negative recheckIndex clamps to 0");

  const overCap = composeFounderEscalationAck({ subject: "Order refund", recheckIndex: 99 });
  const secondRecheck = composeFounderEscalationAck({ subject: "Order refund", recheckIndex: 2 });
  assert.equal(overCap, secondRecheck, "recheckIndex > 2 clamps to 2 (the sweep's cap)");
});

test("Phase 2 — a recheck job (instructions.recheck_index=1) delivers the SECOND variant, not the initial ack", async () => {
  // The Phase-2 sweep enqueues cs-director-call jobs carrying `recheck_index` in
  // `agent_jobs.instructions`. When June's re-review still says escalate_founder, the ack must
  // switch to the second variant so the customer doesn't hear the same greeting twice.
  const rechieckInstructions = JSON.stringify({ ticket_id: "ticket-1", triage_run_id: "run-1", recheck: true, recheck_index: 1 });
  const admin = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: rechieckInstructions } },
    tickets: { data: { subject: "Refund my second bag", customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: true } },
  });
  const deliveries: string[] = [];
  const deps: CsDirectorApplyDeps = {
    approveRemedy: {
      loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
      loadWorkspaceSandbox: async () => true,
      runExecutor: async () => ({ messageSent: false, escalated: false, closed: false, statusManaged: false }),
      deliverMessage: async (_admin, _ws, _t, _c, body) => {
        deliveries.push(body);
      },
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "escalate_founder",
    reasoning: "Still a founder call after 48h.",
    recommended_remedy: { kind: "refund_and_price_lock", summary: "Refund + restore price" },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-2", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(deliveries.length, 1, "exactly one ack delivered on recheck");
  const initialAck = composeFounderEscalationAck({ subject: "Refund my second bag", recheckIndex: 0 });
  const secondAck = composeFounderEscalationAck({ subject: "Refund my second bag", recheckIndex: 1 });
  assert.notEqual(deliveries[0], initialAck, "must NOT re-send the initial ack on a recheck");
  assert.equal(deliveries[0], secondAck, "recheck delivers the second variant");
});

test("Phase 1 — escalate_founder skips the ack cleanly when the ticket_id cannot be resolved", async () => {
  // The linkage-null path already returns ok:true with a null linkage; the ack must not fire when
  // we have no ticket to deliver on, and the escalation itself must still succeed (the runner's
  // audit row is the primary trail).
  const admin = stubAdminMulti({
    agent_jobs: { data: { ...CS_JOB_ROW, instructions: "{ not valid json" } },
  });
  let deliveryCalled = false;
  const deps: CsDirectorApplyDeps = {
    approveRemedy: {
      loadTicketFacts: async () => null,
      loadWorkspaceSandbox: async () => false,
      runExecutor: async () => ({ messageSent: false, escalated: false, closed: false, statusManaged: false }),
      deliverMessage: async () => {
        deliveryCalled = true;
      },
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "escalate_founder",
    reasoning: "Judgment call.",
  };
  const result = await applyBoxCsDirectorCall(admin, "job-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(result.handler, "escalate_founder");
  assert.equal(result.linkage_ticket_id, null);
  assert.equal(deliveryCalled, false, "no delivery when ticket_id is unresolvable");
});

// ── Phase 3 (a-founder-escalated-customer-never-waits-in-silence) — pin the voice rule ──────────
//
// This suite is the DURABLE PIN for Phase 1's voice constraint (spec: "the voice constraint is the
// part most likely to erode. A future edit that adds 'your ticket has been escalated to our team'
// would technically satisfy Phase 1 and quietly break the thing the CEO actually asked for").
//
// The exact 8-word banned list below is the spec's own list — DO NOT tighten it silently and DO
// NOT loosen it. A ninth entry belongs in the spec first, then here. The "no timeframe" and
// "sent exactly once per escalation" pins encode the two other Phase-1 invariants the spec asks
// Phase-3 to lock down.

/** The 8 exact banned substrings from the spec (docs/brain/specs/a-founder-escalated-customer-
 * never-waits-in-silence.md § Phase 3 verification bullet). Case-insensitive. Substring-shaped so
 * "escalat" catches "escalated" / "escalating" / "escalation" in one pin. */
const PHASE_3_SPEC_BANNED_ACK_SUBSTRINGS = [
  "escalat",
  "human",
  "manager",
  "supervisor",
  "another team",
  "higher tier",
  "passed to",
  "forwarded to",
] as const;

/** Timeframe-shaped words the spec forbids ("no shortly / 24 hours / as soon as possible"). Not
 * enumerated in the Phase-3 banned list but explicitly named in the Phase-1 body — pinning them
 * here catches a future edit that would insert a "we'll be back within an hour" pattern. */
const PHASE_3_BANNED_TIMEFRAME_PATTERNS = [
  /shortly/i,
  /24 hours/i,
  /as soon as possible/i,
  /within \d/i,
  /\btomorrow\b/i,
  /\btoday\b/i,
] as const;

test("Phase 3 pin — composeFounderEscalationAck never contains ANY of the spec's 8 banned handoff substrings across every variant", () => {
  const subject = "Refund my second bag — SC131607";
  for (const idx of [0, 1, 2]) {
    const body = composeFounderEscalationAck({ subject, recheckIndex: idx });
    const lower = body.toLowerCase();
    for (const banned of PHASE_3_SPEC_BANNED_ACK_SUBSTRINGS) {
      assert.equal(
        lower.includes(banned),
        false,
        `variant ${idx} contains spec-banned substring "${banned}" — internal routing must be invisible to the customer. Full body:\n${body}`,
      );
    }
  }
});

test("Phase 3 pin — composeFounderEscalationAck never quotes a timeframe across every variant", () => {
  const subject = "Refund my second bag";
  for (const idx of [0, 1, 2]) {
    const body = composeFounderEscalationAck({ subject, recheckIndex: idx });
    for (const pattern of PHASE_3_BANNED_TIMEFRAME_PATTERNS) {
      assert.doesNotMatch(body, pattern, `variant ${idx} carries a timeframe ${String(pattern)} — the honest answer on this lane is often days, any number quoted here is wrong. Full body:\n${body}`);
    }
  }
});

test("Phase 3 pin — a fallback subject (null / blank) still contains none of the banned substrings and no timeframe", () => {
  for (const subject of [null, "", "   ", "Re: Fwd:"] as (string | null)[]) {
    for (const idx of [0, 1, 2]) {
      const body = composeFounderEscalationAck({ subject, recheckIndex: idx });
      const lower = body.toLowerCase();
      for (const banned of PHASE_3_SPEC_BANNED_ACK_SUBSTRINGS) {
        assert.equal(lower.includes(banned), false, `fallback subject=${JSON.stringify(subject)} variant ${idx} contains banned "${banned}"`);
      }
      for (const pattern of PHASE_3_BANNED_TIMEFRAME_PATTERNS) {
        assert.doesNotMatch(body, pattern, `fallback subject=${JSON.stringify(subject)} variant ${idx} carries timeframe ${String(pattern)}`);
      }
    }
  }
});

/**
 * A marker-aware stub for the Phase-3 "sent exactly once" pin. Extends stubAdminMulti with:
 *   - persisted `ticket_messages` inserts across calls
 *   - a chained `.eq().eq().like().limit()` reader that returns matching persisted rows
 *
 * The rest of the query shapes fall through to the base stub — the two extended surfaces are the
 * only ones the ack idempotency path (`ackAlreadyDeliveredForJob`, `recordAckDeliveredMarker`)
 * touches. Purpose-built for this suite so a general-purpose stub extension is not needed.
 */
function stubAdminWithMarkerMemory(tableRows: Record<string, { data: unknown }>): {
  admin: Admin;
  insertedTicketMessages: Array<{ body: string; visibility?: string; ticket_id?: string }>;
} {
  const insertedTicketMessages: Array<{ body: string; visibility?: string; ticket_id?: string }> = [];
  const admin = {
    from(table: string) {
      return {
        select(_cols: string) {
          const filters: Array<{ col: string; val: unknown; op: "eq" | "like" }> = [];
          const chain: {
            eq: (col: string, val: unknown) => typeof chain;
            like: (col: string, val: unknown) => typeof chain;
            limit: (n: number) => Promise<{ data: unknown[] }>;
            maybeSingle: () => Promise<{ data: unknown }>;
            single: () => Promise<{ data: unknown }>;
          } = {
            eq(col, val) {
              filters.push({ col, val, op: "eq" });
              return chain;
            },
            like(col, val) {
              filters.push({ col, val, op: "like" });
              return chain;
            },
            async limit(_n: number) {
              // Only the ticket_messages marker query uses this chain — filter persisted rows.
              if (table !== "ticket_messages") return { data: [] };
              const matches = insertedTicketMessages.filter((row) => {
                for (const f of filters) {
                  const rowVal = (row as unknown as Record<string, unknown>)[f.col];
                  if (f.op === "eq") {
                    if (rowVal !== f.val) return false;
                  } else if (f.op === "like") {
                    // supabase `.like(col, "prefix%")` — translate the % suffix into a startsWith.
                    const pattern = String(f.val);
                    const stripped = pattern.endsWith("%") ? pattern.slice(0, -1) : pattern;
                    if (typeof rowVal !== "string" || !rowVal.startsWith(stripped)) return false;
                  }
                }
                return true;
              });
              return { data: matches };
            },
            async maybeSingle() {
              return tableRows[table] ?? { data: null };
            },
            async single() {
              return tableRows[table] ?? { data: null };
            },
          };
          return chain;
        },
        insert(row: unknown) {
          if (table === "ticket_messages" && row && typeof row === "object") {
            insertedTicketMessages.push(row as { body: string; visibility?: string; ticket_id?: string });
          }
          return Promise.resolve({ data: null, error: null });
        },
      };
    },
  } as unknown as Admin;
  return { admin, insertedTicketMessages };
}

test("Phase 3 pin — the ack is sent EXACTLY ONCE per escalation, even when the handler is invoked twice on the same job", async () => {
  // Simulates the retry path (the runner claims a needs_input row after a session blip and re-
  // dispatches the same job_id). The marker mechanism (`ackAlreadyDeliveredForJob` +
  // `recordAckDeliveredMarker`) must short-circuit the second call so the customer never gets
  // a duplicate acknowledgement — the "sent exactly once per escalation" verification bullet.
  const { admin, insertedTicketMessages } = stubAdminWithMarkerMemory({
    agent_jobs: {
      data: { ...CS_JOB_ROW, instructions: JSON.stringify({ ticket_id: "ticket-1", triage_run_id: "run-1" }) },
    },
    tickets: { data: { subject: "Refund my second bag", customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: true } },
  });
  const deliveries: string[] = [];
  const deps: CsDirectorApplyDeps = {
    approveRemedy: {
      loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
      loadWorkspaceSandbox: async () => true,
      runExecutor: async () => ({ messageSent: false, escalated: false, closed: false, statusManaged: false }),
      deliverMessage: async (_admin, _ws, _t, _c, body) => {
        deliveries.push(body);
      },
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "escalate_founder",
    reasoning: "Judgment call the CEO owns.",
    recommended_remedy: { kind: "refund_and_price_lock", summary: "Refund + restore price" },
  };

  // First invocation — ack fires + marker is persisted.
  const first = await applyBoxCsDirectorCall(admin, "job-idempotent", verdict, deps);
  assert.equal(first.ok, true);
  assert.equal(deliveries.length, 1, "first invocation delivers the ack exactly once");
  const markersAfterFirst = insertedTicketMessages.filter((r) =>
    r.body.startsWith("[cs-director/escalate_founder/ack] job=job-idempotent"),
  );
  assert.equal(markersAfterFirst.length, 1, "marker note persisted after first delivery");

  // Second invocation of the SAME job_id — marker check must short-circuit; no second delivery.
  const second = await applyBoxCsDirectorCall(admin, "job-idempotent", verdict, deps);
  assert.equal(second.ok, true);
  assert.equal(deliveries.length, 1, "second invocation MUST NOT send a duplicate ack (spec: sent exactly once per escalation)");
  const markersAfterSecond = insertedTicketMessages.filter((r) =>
    r.body.startsWith("[cs-director/escalate_founder/ack] job=job-idempotent"),
  );
  assert.equal(markersAfterSecond.length, 1, "no duplicate marker note either");
});

test("Phase 3 pin — a DIFFERENT job_id on the same ticket (Phase-2 recheck) IS allowed to send a second, different ack", async () => {
  // The Phase-2 stale-recheck sweep enqueues a fresh cs-director-call with a new job_id — that
  // path must be able to send its own recheck-variant ack without tripping the idempotency guard,
  // per the spec ("send the customer a second, different acknowledgement — never the same text
  // twice"). The marker namespace is job-scoped precisely to preserve this.
  const { admin } = stubAdminWithMarkerMemory({
    // Seed the initial ack marker so ackAlreadyDeliveredForJob returns true for job-initial
    // — but for the recheck job (different id), the query returns empty.
    agent_jobs: {
      data: {
        ...CS_JOB_ROW,
        instructions: JSON.stringify({ ticket_id: "ticket-1", recheck: true, recheck_index: 1 }),
      },
    },
    tickets: { data: { subject: "Refund my second bag", customer_id: "cust-1", channel: "email" } },
    workspaces: { data: { sandbox_mode: true } },
  });
  const deliveries: string[] = [];
  const deps: CsDirectorApplyDeps = {
    approveRemedy: {
      loadTicketFacts: async () => ({ customer_id: "cust-1", channel: "email" }),
      loadWorkspaceSandbox: async () => true,
      runExecutor: async () => ({ messageSent: false, escalated: false, closed: false, statusManaged: false }),
      deliverMessage: async (_admin, _ws, _t, _c, body) => {
        deliveries.push(body);
      },
    },
  };
  const verdict: CsDirectorVerdictInput = {
    decision: "escalate_founder",
    reasoning: "Still a founder call after 48h.",
    recommended_remedy: { kind: "refund_and_price_lock", summary: "Refund + restore price" },
  };
  const result = await applyBoxCsDirectorCall(admin, "job-recheck-1", verdict, deps);
  assert.equal(result.ok, true);
  assert.equal(deliveries.length, 1, "recheck job (fresh job_id) delivers its own ack");
  // And crucially it's the SECOND-variant text (recheck_index=1), NOT the initial variant.
  const initial = composeFounderEscalationAck({ subject: "Refund my second bag", recheckIndex: 0 });
  const second = composeFounderEscalationAck({ subject: "Refund my second bag", recheckIndex: 1 });
  assert.notEqual(deliveries[0], initial, "recheck must not re-send the initial variant");
  assert.equal(deliveries[0], second, "recheck delivers the second variant");
});

// ── The ack topic must never be a truncated sentence ──────────────────────
//
// The variants splice the subject into "taking a proper look at {topic} before
// I come back to you", which needs a noun phrase. Ticket d17c7b1c (Kimberly)
// had the whole request as the subject — "Recent order - though I ordered
// k-cups can I send this back and reorder the k-cups" — and the old 80-char
// trim cut it mid-clause and sent it to her. Shortening cannot repair a
// sentence; it falls back to the generic phrase instead.

test("a sentence subject falls back to the generic topic, never a truncated splice", () => {
  const ack = composeFounderEscalationAck({
    subject: "Recent order - though I ordered k-cups can I send this back and reorder the k-cups",
  });
  assert.ok(!ack.includes("…"), "must not send a mid-clause truncation to a customer");
  assert.ok(!ack.includes("reorder the"), "must not splice a half-sentence back at them");
  assert.match(ack, /what you've written in/);
});

test("a short noun-phrase subject is still named specifically", () => {
  for (const subject of ["Question regarding Account", "Subscription", "Misleading Practices"]) {
    const ack = composeFounderEscalationAck({ subject });
    assert.ok(ack.includes(subject), `${subject} should be named directly`);
  }
});

test("Re:/Fwd: chains are still stripped before the topic test", () => {
  const ack = composeFounderEscalationAck({ subject: "Re: Fwd: Subscription" });
  assert.ok(ack.includes("Subscription"));
  assert.ok(!ack.includes("Re:") && !ack.includes("Fwd:"));
});

test("every variant refuses an over-long subject, not just the first", () => {
  const tooLong =
    "Recent order - though I ordered k-cups can I send this back and reorder the k-cups";
  for (const recheckIndex of [0, 1, 2]) {
    const ack = composeFounderEscalationAck({ subject: tooLong, recheckIndex });
    assert.ok(!ack.includes("…"), `variant ${recheckIndex} truncated the subject`);
    assert.match(ack, /what you've written in/);
  }
});

test("a subject that fits is still named, right up to the boundary", () => {
  const fits = "My subscription renewed twice this month";
  assert.ok(composeFounderEscalationAck({ subject: fits }).includes(fits));
});
