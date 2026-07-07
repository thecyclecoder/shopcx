/**
 * Fix the order-address fallback bug that shipped Catherine Green's replacement
 * to a stale Rochester address (ticket 49ddd6c4). create_replacement_order (and
 * create_order) resolve the destination from a CITED ORDER's historical
 * shipping_address, which shadows the customer's CURRENT canonical address
 * (account default_address / active subscription). A customer who has moved gets
 * the replacement at their OLD address. Fix: prefer current canonical address
 * over the stale order snapshot, via one shared resolver used by every
 * order-creating action. cs-owned (ticket-derived code spec). Lands in_review.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const s = await authorSpecRowStructured(
    WS,
    "replacement-address-uses-current-canonical-not-stale-order",
    {
      title: "Order-creating actions ship to the customer's CURRENT address, not a stale cited-order snapshot",
      why: "Catherine Green's replacement (ticket 49ddd6c4) kept shipping to her old Rochester address even though her account default and her active subscription both showed the correct Kirkland address. The cause: create_replacement_order resolves the destination by preferring the cited original order's historical shipping address ABOVE the customer's current subscription/account address — so when a customer moves, the replacement copies the stale address off the old order. create_order has the same shape (it reads a cited order's shipping_address). Meanwhile update_shipping_address already treats the account default address as the canonical source future orders should pick up. A replacement or new order should go where the customer lives NOW, not where an old order went — unless an operator explicitly overrides the destination.",
      what: "One shared resolver that returns the customer's CURRENT canonical shipping address — explicit operator override first, then account default address, then active subscription, and only as a last resort a cited order's historical snapshot — used by create_replacement_order and create_order so no order-creating path can ship to a stale address. When the resolved current address differs from a cited order's address, log the divergence (the exact Catherine signal).",
      summary: "**Brain refs:** [[../libraries/action-executor]] [[../libraries/commerce__order]] [[../tables/orders]] [[../tables/subscriptions]] [[../tables/customers]]. **Derived-from-ticket:** 49ddd6c4 (Catherine Green — replacement shipped to stale Rochester MN; correct address Kirkland WA on account default_address + subscription). Grounded in: src/lib/action-executor.ts create_replacement_order (~:1856 address priority — order_number snapshot at :1870 shadows the subscription at :1878) and create_order (~:983-996, reads a cited order's shipping_address), customers.default_address (canonical current address, written by update_shipping_address ~:1545), subscriptions.shipping_address, src/lib/replacement-order.ts createReplacementOrder.",
      owner: "cs",
      parent: '[[../functions/cs]] — "Ticket-derived product fixes" mandate: a fix surfaced by a real ticket (49ddd6c4) — order-creating actions must ship to the customer\'s current address, not a stale snapshot off an old order.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — a shared current-address resolver; create_replacement_order uses it",
          why: "The bug is a priority inversion: a historical order snapshot outranks the customer's current address. A single resolver with the correct priority fixes it deterministically and becomes the one place the rule lives.",
          what: "A resolver that returns the current canonical shipping address (explicit override → account default → active subscription → cited-order snapshot as last resort), wired into create_replacement_order; plus a divergence log when the current address differs from a cited order's address.",
          body: "Add a resolveCustomerShippingAddress(admin, workspaceId, customerId, { addressOverride?, orderNumber?, subscriptionId? }) helper (its own module or in [[../libraries/action-executor]]). Priority: (1) explicit addressOverride, (2) customers.default_address ([[../tables/customers]] — the canonical current address update_shipping_address writes ~:1545), (3) active subscription shipping_address ([[../tables/subscriptions]]; when a subscriptionId is given, prefer that sub), (4) LAST RESORT the cited order's shipping_address ([[../tables/orders]]). Repoint create_replacement_order (src/lib/action-executor.ts ~:1856) to call it — the current fallback puts order_number (:1870) ABOVE subscription (:1878); invert so current-canonical wins. When (4) would differ from the resolved current address, emit an internal divergence note (customer moved; shipping to current address) — the signal the system had but ignored on 49ddd6c4. Explicit override still wins so an operator can force a one-off destination. Cite the create_replacement_order priority block + customers.default_address.",
          verification: "For a customer whose account default + subscription say Kirkland but whose cited order says Rochester, create_replacement_order resolves to Kirkland (regression pin for 49ddd6c4). An explicit address override still wins over everything. A customer with only an old order and no current address on file still resolves to the order address (last-resort fallback preserved). A divergence between current address and the cited order's address is logged.",
          status: "planned",
        },
        {
          title: "Phase 2 — route create_order through the same resolver so the bug class can't recur",
          why: "create_order snapshots a cited order's address the same way, so the identical stale-address bug is latent there; sharing one resolver closes the whole class, not just the one instance.",
          what: "create_order (and any other order-creating action that derives a destination from a cited order) resolves its shipping address through the shared resolver instead of reading a cited order's shipping_address directly.",
          body: "Repoint create_order (src/lib/action-executor.ts ~:983-996, which currently reads order.shipping_address off a cited order) to resolveCustomerShippingAddress with the same priority, so a new order also ships to the customer's current address unless overridden. Audit the other commerce order-creating actions ([[../libraries/commerce__order]]) for the same cited-order-snapshot pattern and route them through the resolver too. Cite create_order's address read + the commerce order helpers.",
          verification: "create_order for a moved customer ships to their current address, not the cited order's stale one (same regression shape as Phase 1). A grep/audit confirms no order-creating action reads a cited order's shipping_address directly to set a destination — all go through resolveCustomerShippingAddress. Explicit override still honored everywhere.",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "cs#ticket-derived" },
  );
  console.log("spec (replacement-address-uses-current-canonical-not-stale-order):", s ? "authored" : "FAILED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
