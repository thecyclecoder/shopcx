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
 * Phase 1 of [[cancel-after-renewal]]: "active" now means the crisis row's linked
 * subscription is not CANCELLED. Ground truth: ticket b44584dc (Brooke Miedema)
 * cancelled 2h20m after a renewal charged and asked for a refund; her Strawberry
 * Lemonade crisis row had `cancelled=false` but pointed at a cancelled subscription,
 * so the guard fired and kept her cancel-after-renewal refund out of the Refund
 * playbook. The last test asserts that a crisis row on a cancelled sub routes into
 * the Refund playbook instead of deferring.
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
  // crisis_customer_actions rows (each with its joined subscription status) returned
  // for the crisis read — the guard filters out rows whose subscription is cancelled.
  crisisRows: Array<{ subscriptions: { status: string } | null }>;
}

/**
 * A minimal Supabase-shaped stub. Routes by table name:
 *  - tickets  → terminal `.single()` resolves `{ data: ticket }`
 *  - playbooks → terminal `.order()` resolves `{ data: playbooks }`
 *  - crisis_customer_actions → thenable chain resolves `{ data: crisisRows }`
 * If the router routes (expected only in the cancelled-sub test) `startPlaybook`'s
 * `.update(...).eq(...)` would be hit — we throw so a route is observable.
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
      // thenable so the crisis read (ends on `.eq('cancelled', false)`) awaits here
      then(resolve: (v: unknown) => void) {
        resolve({ data: opts.crisisRows, count: null, error: null });
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

test("crisis-confirmed customer (ACTIVE sub) + refund_request + stand-firm Refund playbook → defers to orchestrator (NOT routed)", async () => {
  const admin = stubAdmin({
    ticket: { active_playbook_id: null, customer_id: "cust-april" },
    playbooks: [REFUND_STAND_FIRM],
    crisisRows: [{ subscriptions: { status: "active" } }],
  });
  const r = await routeIntentToPlaybook(admin as never, "ws-1", "tkt-1", "refund_request");
  assert.equal(r.routed, false);
  assert.equal(
    (r as { reason: string }).reason,
    "crisis_customer_defers_to_orchestrator",
    "a crisis-confirmed refund intent must fall through to the Sonnet white-glove crisis path",
  );
});

test("crisis row on a CANCELLED subscription + refund_request → the guard does NOT fire (routes into Refund playbook)", async () => {
  // Brooke Miedema: her only crisis row has cancelled=false but points at a cancelled
  // subscription, so the guard must ignore it and let the router start the Refund
  // playbook. The stubbed `.update` throws, proving the router reached the routing path.
  const admin = stubAdmin({
    ticket: { active_playbook_id: null, customer_id: "cust-brooke" },
    playbooks: [REFUND_STAND_FIRM],
    crisisRows: [{ subscriptions: { status: "cancelled" } }],
  });
  await assert.rejects(
    () => routeIntentToPlaybook(admin as never, "ws-1", "tkt-brooke", "refund_request"),
    /unexpected write to tickets|unexpected write to playbooks/,
    "a crisis row on a cancelled subscription must not keep a cancel-after-renewal refund out of the Refund playbook",
  );
});

test("NON-crisis customer + refund_request + stand-firm Refund playbook → the guard does NOT fire (would route)", async () => {
  // No crisis rows means the guard is skipped; the router proceeds to startPlaybook,
  // whose stubbed `.update` throws — proving the guard did NOT short-circuit and the
  // routing path was reached for a non-crisis customer (narrowness of the guard).
  const admin = stubAdmin({
    ticket: { active_playbook_id: null, customer_id: "cust-normal" },
    playbooks: [REFUND_STAND_FIRM],
    crisisRows: [],
  });
  await assert.rejects(
    () => routeIntentToPlaybook(admin as never, "ws-1", "tkt-2", "refund_request"),
    /unexpected write to tickets|unexpected write to playbooks/,
    "a non-crisis customer must still reach the normal routing path (guard is narrow)",
  );
});
