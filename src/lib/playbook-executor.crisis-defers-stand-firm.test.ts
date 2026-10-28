/**
 * Crisis-enrollment guard on the deterministic intent→playbook router.
 *
 * Ground truth: ticket cbdde02c (April McEntire, LTV $2891.87, tagged
 * `hard:crisis-enrollment` every turn). Her `refund_request` message matched the
 * Refund playbook's `trigger_intents`, so `routeIntentToPlaybook` started the
 * Refund playbook's stand-firm ladder deterministically and stood firm 4 rounds —
 * exactly the routing the Crisis Policy white-glove rule forbids. The fix gates
 * the router: when the matched playbook is a STAND-FIRM playbook (`stand_firm_max
 * > 0`) AND the customer has an ACTIVE crisis_customer_actions enrollment, the
 * router returns `routed:false` with reason `crisis_customer_defers_to_orchestrator`
 * so unified-ticket-handler falls through to the Sonnet white-glove crisis path
 * instead of short-circuiting on `intent_playbook_routed`.
 *
 * Run: `npx tsx --test src/lib/playbook-executor.crisis-defers-stand-firm.test.ts`.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { routeIntentToPlaybook } from "./playbook-executor";

interface StubOpts {
  // ticket row returned by .from('tickets').select(...).single()
  ticket: { active_playbook_id: string | null; customer_id: string | null };
  // playbook rows returned by .from('playbooks')....order()
  playbooks: Array<{
    id: string;
    name: string;
    slug: string;
    trigger_intents: string[];
    stand_firm_max: number;
  }>;
  // count returned for the crisis_customer_actions head/count read
  crisisCount: number;
}

/**
 * A minimal Supabase-shaped stub. Routes by table name:
 *  - tickets  → terminal `.single()` resolves `{ data: ticket }`
 *  - playbooks → terminal `.order()` resolves `{ data: playbooks }`
 *  - crisis_customer_actions → thenable chain resolves `{ count: crisisCount }`
 * If the router routes (never expected in these tests) `startPlaybook`'s
 * `.update(...).eq(...)` would be hit — we throw so a stray route is loud.
 */
function stubAdmin(opts: StubOpts): unknown {
  function chainFor(table: string): unknown {
    const chain: Record<string, unknown> = {
      select() {
        return chain;
      },
      eq() {
        return chain;
      },
      is() {
        return chain;
      },
      order() {
        return Promise.resolve({ data: opts.playbooks, error: null });
      },
      single() {
        return Promise.resolve({ data: opts.ticket, error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: opts.ticket, error: null });
      },
      update() {
        throw new Error(`unexpected write to ${table} — router should have deferred`);
      },
      // thenable so the crisis count read (ends on `.eq('cancelled', false)`) awaits here
      then(resolve: (v: unknown) => void) {
        resolve({ count: opts.crisisCount, data: null, error: null });
      },
    };
    return chain;
  }
  return { from(table: string) { return chainFor(table); } };
}

const REFUND_STAND_FIRM = {
  id: "pb-refund",
  name: "Refund",
  slug: "refund",
  trigger_intents: ["refund_request", "unwanted_charge", "charged_without_permission"],
  stand_firm_max: 3,
};

test("crisis-confirmed customer + refund_request + stand-firm Refund playbook → defers to orchestrator (NOT routed)", async () => {
  const admin = stubAdmin({
    ticket: { active_playbook_id: null, customer_id: "cust-april" },
    playbooks: [REFUND_STAND_FIRM],
    crisisCount: 1,
  });
  const r = await routeIntentToPlaybook(admin as never, "ws-1", "tkt-1", "refund_request");
  assert.equal(r.routed, false);
  assert.equal(
    (r as { reason: string }).reason,
    "crisis_customer_defers_to_orchestrator",
    "a crisis-confirmed refund intent must fall through to the Sonnet white-glove crisis path",
  );
});

test("NON-crisis customer + refund_request + stand-firm Refund playbook → the guard does NOT fire (would route)", async () => {
  // crisisCount:0 means the guard is skipped; the router proceeds to startPlaybook,
  // whose stubbed `.update` throws — proving the guard did NOT short-circuit and the
  // routing path was reached for a non-crisis customer (narrowness of the guard).
  const admin = stubAdmin({
    ticket: { active_playbook_id: null, customer_id: "cust-normal" },
    playbooks: [REFUND_STAND_FIRM],
    crisisCount: 0,
  });
  await assert.rejects(
    () => routeIntentToPlaybook(admin as never, "ws-1", "tkt-2", "refund_request"),
    /unexpected write to tickets|unexpected write to playbooks/,
    "a non-crisis customer must still reach the normal routing path (guard is narrow)",
  );
});
