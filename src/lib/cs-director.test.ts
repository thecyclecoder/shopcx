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
  extractRemedyCustomerMessage,
  planAuthorSpec,
  planRemedyExecution,
  type ApproveRemedyDeps,
  type AuthorSpecDeps,
  type CsDirectorApplyDeps,
  type CsDirectorVerdictInput,
} from "./cs-director";
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
  }
});

test("planRemedyExecution — missing action_type is fail-safe", () => {
  const result = planRemedyExecution({ payload: { next_billing_date: "2026-10-06" } });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "remedy_missing_action_type");
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

test("buildRemedySonnetDecision — falls back to a synthetic reasoning when the input is empty", () => {
  const decision = buildRemedySonnetDecision(
    { actionType: "resume", actionParams: {}, customerMessage: null },
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
