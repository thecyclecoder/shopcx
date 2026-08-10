/**
 * Unit tests for `buildAssistedPurchaseFailureCard` — the pure builder used by
 * `handleAssistedCreate` (src/lib/playbook-executor.ts) AND `handleApproveRemedy`
 * (src/lib/cs-director.ts) to mint the CEO inbox card when a create_subscription /
 * create_order fails at the terminal step of an assisted purchase.
 *
 * Verification bullets (Phase 2 of create-subscription-internal-branch-cannot-create-a-subscription):
 *  - A failed assisted-purchase terminal action yields a CEO-routed `agent_approval_request` card
 *    so the founder sees the failure instead of it dead-ending on an open + unowned ticket
 *    (Susan Bellamy 2-week / 15-message gap).
 *  - The card body names the customer, the exact plan they agreed to, the origin (playbook OR
 *    cs-director remedy), and the concrete failure so the founder acts without opening the ticket.
 *  - `plan` persists on metadata verbatim so a downstream approver can pick it up structurally.
 *  - Missing/empty customer name still yields a coherent title (falls back to email → id-8).
 *  - Missing/empty plan items still yields a coherent body (never a bare surface).
 *
 * Pure helper — no network, no DB. Run:
 *   npx tsx --test src/lib/assisted-purchase-failure-card.test.ts
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAssistedPurchaseFailureCard,
  summarizeCustomer,
  summarizePlan,
} from "./assisted-purchase-failure-card";

test("every assisted-purchase failure yields a CEO-routed agent_approval_request card shape", () => {
  const row = buildAssistedPurchaseFailureCard({
    ticketId: "687b2e7a-6117-438f-8d6a-9417544e0074",
    actionType: "create_subscription",
    customerId: "cust-abc-1234",
    customerFirstName: "Susan",
    customerLastName: "Bellamy",
    plan: {
      vendor: "internal",
      billing_interval: "month",
      billing_interval_count: 1,
      next_billing_date: "2026-08-15",
      items: [{ variant_id: "v-1", title: "Superfoods", quantity: 1 }],
    },
    failureError: 'null value in column "shopify_contract_id" violates not-null constraint',
    origin: "playbook",
    jobId: "job-xyz-1",
  });
  assert.equal(row.metadata.routed_to_function, "ceo", "routes to the CEO seat");
  assert.equal(row.metadata.escalation_kind, "assisted_purchase_failure");
  assert.equal(row.metadata.raised_by_function, "cs");
  assert.equal(row.metadata.action_type, "create_subscription");
  assert.equal(row.metadata.origin, "playbook");
  assert.equal(row.metadata.ticket_id, "687b2e7a-6117-438f-8d6a-9417544e0074");
  assert.equal(row.metadata.customer_id, "cust-abc-1234");
  assert.equal(row.metadata.agent_job_id, "job-xyz-1");
  assert.equal(row.link, "/dashboard/tickets/687b2e7a-6117-438f-8d6a-9417544e0074");
});

test("card title + body name the customer, plan, origin, and concrete failure", () => {
  const row = buildAssistedPurchaseFailureCard({
    ticketId: "t-1",
    actionType: "create_subscription",
    customerId: "cust-1",
    customerFirstName: "Susan",
    customerLastName: "Bellamy",
    plan: {
      billing_interval: "month",
      billing_interval_count: 1,
      next_billing_date: "2026-08-15",
      items: [{ title: "Superfoods", quantity: 1 }, { title: "Greens", quantity: 2 }],
    },
    failureError: 'null value in column "shopify_contract_id"',
    origin: "playbook",
  });
  assert.match(row.title, /Assisted-purchase subscription FAILED — Susan Bellamy/);
  assert.match(row.body, /Customer: Susan Bellamy/);
  assert.match(row.body, /Plan agreed to: Superfoods \+ Greens ×2 · every 1 month · starts 2026-08-15/);
  assert.match(row.body, /Origin: assisted-purchase playbook/);
  assert.match(row.body, /Failure: null value in column "shopify_contract_id"/);
});

test("director_remedy origin renders as `cs-director remedy` in the body + metadata", () => {
  const row = buildAssistedPurchaseFailureCard({
    ticketId: "t-1",
    actionType: "create_subscription",
    customerId: "cust-1",
    customerFirstName: "Susan",
    customerLastName: "Bellamy",
    plan: { billing_interval: "month", billing_interval_count: 1, items: [{ title: "x", quantity: 1 }] },
    origin: "director_remedy",
    jobId: "job-42",
  });
  assert.equal(row.metadata.origin, "director_remedy");
  assert.match(row.body, /Origin: cs-director remedy/);
  assert.equal(row.metadata.agent_job_id, "job-42");
});

test("metadata.plan persists the plan verbatim so a downstream approver can pick it up structurally", () => {
  const plan = {
    vendor: "internal",
    billing_interval: "month",
    billing_interval_count: 1,
    next_billing_date: "2026-08-15",
    items: [{ variant_id: "v-1", title: "Superfoods", quantity: 2 }],
  };
  const row = buildAssistedPurchaseFailureCard({
    ticketId: "t-1",
    actionType: "create_subscription",
    customerId: "cust-1",
    plan,
    origin: "playbook",
  });
  assert.deepEqual(row.metadata.plan, plan);
});

test("missing customer name falls back to email, then to `customer <id-8>` — never a bare `customer`", () => {
  assert.equal(
    summarizeCustomer({
      customerId: "abcdef1234567890",
      customerFirstName: null,
      customerLastName: null,
      customerEmail: null,
    }),
    "customer abcdef12",
  );
  assert.equal(
    summarizeCustomer({
      customerId: "abcdef1234567890",
      customerFirstName: null,
      customerLastName: null,
      customerEmail: "susan@example.com",
    }),
    "susan@example.com",
  );
  assert.equal(
    summarizeCustomer({
      customerId: "abcdef1234567890",
      customerFirstName: "Susan",
      customerLastName: null,
    }),
    "Susan",
  );
});

test("missing/empty plan items still yield a coherent body — never a bare surface", () => {
  const row = buildAssistedPurchaseFailureCard({
    ticketId: "t-1",
    actionType: "create_subscription",
    customerId: "cust-1",
    plan: { billing_interval: "month", billing_interval_count: 1, items: [] },
    origin: "playbook",
  });
  assert.match(row.body, /Plan agreed to: \(no items listed\) · every 1 month/);
});

test("missing failure_error surfaces `(no error message recorded)` — never a dangling label", () => {
  const row = buildAssistedPurchaseFailureCard({
    ticketId: "t-1",
    actionType: "create_subscription",
    customerId: "cust-1",
    plan: { items: [{ title: "x", quantity: 1 }] },
    origin: "playbook",
  });
  assert.match(row.body, /Failure: \(no error message recorded\)/);
  assert.equal(row.metadata.failure_error, null);
});

test("summarizePlan handles year cadence + quantity pluralization", () => {
  assert.match(summarizePlan({
    billing_interval: "year",
    billing_interval_count: 2,
    items: [{ title: "Bundle", quantity: 3 }],
  }), /Bundle ×3 · every 2 years/);
});

test("create_order variant reads `Assisted-purchase order FAILED — ...` in the title + `create_order` on metadata", () => {
  const row = buildAssistedPurchaseFailureCard({
    ticketId: "t-1",
    actionType: "create_order",
    customerId: "cust-1",
    customerFirstName: "Jane",
    plan: { items: [{ title: "x", quantity: 1 }] },
    origin: "playbook",
  });
  assert.match(row.title, /Assisted-purchase order FAILED — Jane/);
  assert.equal(row.metadata.action_type, "create_order");
});
