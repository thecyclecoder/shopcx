/**
 * Author the two specs for the assisted-purchase capability:
 *  1) add-payment-method-journey (CODE) — a mini-site journey that vaults a
 *     Braintree card, migrates the customer's subs to internal (Option A:
 *     migrate-first, synchronous), and signals completion back to the ticket.
 *  2) assisted-purchase-playbook (DB + thin code) — gate create_order /
 *     create_subscription behind a vaulted PM; when absent, launch the
 *     add_payment_method journey, await it, then create. blocked_by (1).
 *
 * Both retention-owned, mandate-parented (standalone — no in-flight goal).
 * Land in_review (Vale → Ada). Migration ordering = A (migrate-first), per
 * Dylan 2026-07-07: the migration is a synchronous call already wired inline in
 * portal/handlers/payment-method-update, so migrate-first is both the clean end
 * state AND the path of least resistance — no background dispatcher exists.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";

async function main() {
  const j = await authorSpecRowStructured(
    WS,
    "add-payment-method-journey",
    {
      title: "add_payment_method mini-site journey — vault a Braintree card, migrate subs to internal, signal the ticket",
      why: "guaranteed-ticket-handling shipped create_order + create_subscription, but both are EFFECTORS that assume a Braintree vaulted payment_method_id. Most Appstle/Shopify customers have none, so those actions can't fire for them. Sending the customer to the portal risks losing them (a surface they may never return from); the mini-site keeps them inside the ticket flow. We need a journey that collects + vaults a card, migrates their subs to internal on the SAME logic the portal uses, and pings the orchestrator that the payment method is ready — the prerequisite an assisted-purchase playbook awaits.",
      what: "A new add_payment_method journey: a journey_definitions row + add-payment-method-journey-builder.ts rendering a mini-site Braintree card-entry step, whose submit vaults the card and then SYNCHRONOUSLY migrates the customer's Appstle subs to internal (Option A — migrate-first) by reusing the exact portal/handlers/payment-method-update logic, then stamps journey_sessions.outcome and emits a completion signal an awaiting playbook/orchestrator can resume on. Mini-site and live-chat render identically.",
      summary: "**Brain refs:** [[../libraries/cancel-journey-builder]] [[../libraries/journey-step-builder]] [[../libraries/migrate-to-internal]] [[../libraries/portal__handlers__payment-methods]] [[../integrations/braintree]] [[../lifecycles/customer-portal]]. Grounded in: src/lib/portal/handlers/payment-method-update.ts (vault → savePaymentMethod → migrateCustomerAppstleSubsToInternal, synchronous inline today), src/lib/migrate-to-internal.ts (migrateCustomerAppstleSubsToInternal), the existing *-journey-builder.ts pattern (cancel/missing-items/shipping-address), and launchJourneyForTicket. Migration ordering = A (migrate-first, synchronous) — no background migration dispatcher exists (only migration-integrity-sweep / migration-audit-retry reconcile FAILURES).",
      owner: "retention",
      parent: '[[../functions/retention]] — "Subscription continuity & billing integrity" mandate: a customer with no vaulted payment method can add one in-flow and land fully on internal billing, without leaving the ticket.',
      blocked_by: [],
      phases: [
        {
          title: "Phase 1 — journey definition + builder scaffold + launch",
          why: "The journey must exist as a first-class journey_definition with a builder before any playbook can launch it; follow the proven *-journey-builder pattern so mini-site/live-chat parity and delivery come for free.",
          what: "An add_payment_method journey_definitions row and add-payment-method-journey-builder.ts that renders a single mini-site card-entry step backed by a Braintree client token, launchable via launchJourneyForTicket.",
          body: "Add a journey_definitions row keyed 'add_payment_method' (DB-driven, not hardcoded). Create src/lib/add-payment-method-journey-builder.ts following the shape of cancel-journey-builder.ts / shipping-address-journey-builder.ts ([[../libraries/journey-step-builder]]): one step that renders a Braintree Drop-in / hosted-fields card-entry surface, fed a client token via braintreeClientToken. Ensure launchJourneyForTicket resolves the new journey. Mini-site and live-chat MUST emit identical ticket messages (only rendering differs) per the parity rule. Cite the journey-builder pattern + journey_definitions.",
          verification: "launchJourneyForTicket('add_payment_method', ...) creates a journey_sessions row and renders the card-entry step in the mini-site. The live-chat render of the same step produces an identical ticket message (parity assertion). No hardcoded journey config — the definition row drives it.",
          status: "planned",
        },
        {
          title: "Phase 2 — vault + migrate-first submit (reuse the portal handler)",
          why: "The vault + migrate logic already exists and runs synchronously inline in the portal; extracting and reusing it keeps mini-site and portal byte-identical and gives Option A (migrate-first) for free.",
          what: "The step's submit vaults the card, saves it as default, then SYNCHRONOUSLY calls migrateCustomerAppstleSubsToInternal before completing — the same sequence as portal/handlers/payment-method-update.",
          body: "Extract the vault→savePaymentMethod(makeDefault)→migrateCustomerAppstleSubsToInternal sequence from src/lib/portal/handlers/payment-method-update.ts (lines ~66-97) into shared logic both the portal handler and the journey submit call, so the two never drift ([[../libraries/portal__handlers__payment-methods]] [[../libraries/migrate-to-internal]]). Migration runs SYNCHRONOUSLY (Option A migrate-first) — vault, then migrate, then complete; the customer is fully on internal billing before the journey signals done. On vault failure keep the customer in the step with a retry (fail closed — do NOT signal completion). Record migratedCount on the session. Cite braintree vault + migrate-to-internal.",
          verification: "Submitting a valid card in the journey vaults it in Braintree, sets it default, and migrates the customer's Appstle subs to internal in the SAME request (migratedCount reflected on journey_sessions). The extracted logic is called by BOTH the portal handler and the journey (one code path, asserted by test or grep). A vault failure leaves the session open (not completed) and shows a retry.",
          status: "planned",
        },
        {
          title: "Phase 3 — completion signal back to the orchestrator/ticket",
          why: "The whole point is to unblock an awaiting create_order/create_subscription; the journey must emit a deterministic 'PM ready, subs migrated' signal the playbook/orchestrator resumes on.",
          what: "On success the journey stamps journey_sessions.outcome='completed' and emits the ticket-facing completion signal (the resume trigger) carrying the vaulted payment_method_id + migratedCount.",
          body: "On successful vault+migrate, set journey_sessions.outcome='completed' and emit the completion signal the awaiting playbook resumes on — the same resume-after-journey mechanism the cancel playbook uses ([[../libraries/playbook-executor]] resumes after the cancel journey). The signal carries the new payment_method_id so the downstream create step can use it directly. Ticket message on completion is identical whether the customer finished via mini-site or live chat (parity). Cite journey_sessions.outcome + the playbook resume-after-journey path.",
          verification: "Completing the journey sets journey_sessions.outcome='completed' and fires the resume signal exactly once, carrying a valid payment_method_id. A playbook parked on this journey (Spec 2) resumes into its next step on that signal. Abandoning the journey does NOT signal completion (the create stays blocked).",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "retention#billing-integrity" },
  );
  console.log("spec 1 (add-payment-method-journey):", j ? "authored" : "FAILED");

  const p = await authorSpecRowStructured(
    WS,
    "assisted-purchase-playbook",
    {
      title: "Assisted-purchase playbook — gate create_order / create_subscription behind a vaulted PM, launching add_payment_method when missing",
      why: "create_order + create_subscription are EFFECTORS that take a payment_method_id and do NOT handle the no-PM case, so a stateless orchestrator turn can propose an order it cannot fulfill. The correct handling is a playbook: check for a vaulted Braintree PM; if absent, launch the add_payment_method journey and await it; then create. A hard guard on the create actions makes this deterministic — no turn can call them without a PM. The playbook→journey launch+resume plumbing already exists (the cancel playbook launches the cancel journey and resumes on completion), so this is mostly DB definition plus a guard and trigger wiring.",
      what: "A playbook (playbooks + playbook_steps rows) with steps check_vaulted_pm → (if none) launch add_payment_method journey + await completion → create_order/create_subscription, plus three code implications: a check_vaulted_pm step type in the executor, a vaulted-PM guard on create_order/create_subscription in action-executor, and orchestrator trigger wiring so purchase intents route into the playbook.",
      summary: "**Brain refs:** [[../libraries/playbook-executor]] [[../libraries/action-executor]] [[../lifecycles/customer-portal]] [[../lifecycles/subscription-billing]]. Grounded in: src/lib/action-executor.ts (create_order / create_subscription handlers — take payment_method_id, no no-PM branch), src/lib/playbook-executor.ts (launchJourneyForTicket + resume-after-cancel-journey already present; step types check_other_subscriptions / check_tracking as the model for check_vaulted_pm), customer_payment_methods table. Depends on the add_payment_method journey (Spec 1).",
      owner: "retention",
      parent: '[[../functions/retention]] — "Subscription continuity & billing integrity" mandate: create_order / create_subscription only ever fire on a real vaulted payment method, sequencing the customer through add_payment_method first when they have none.',
      blocked_by: ["add-payment-method-journey"],
      phases: [
        {
          title: "Phase 1 — vaulted-PM guard on the create actions (deterministic safety net)",
          why: "The guard is the invariant that makes the whole capability safe: no code path — playbook or stateless turn — can create an order/sub without a payment method to bill.",
          what: "create_order and create_subscription short-circuit when the customer has no vaulted Braintree PM: instead of erroring, they escalate to / hand off to the assisted-purchase flow (launch add_payment_method).",
          body: "In src/lib/action-executor.ts, at the top of create_order and create_subscription, look up a vaulted default PM (customer_payment_methods for the customer). If none, do NOT attempt the create — hand off to the assisted-purchase path (launch the add_payment_method journey or defer to the playbook) and record why. Deterministic + fail-closed: a missing PM can never reach the effector. Cite the create handlers + customer_payment_methods.",
          verification: "create_order / create_subscription for a customer with NO vaulted PM never calls the commerce effector — it routes to add_payment_method instead (unit/integration). A customer WITH a vaulted default PM proceeds to create normally. The guard is unconditional (no flag bypass).",
          status: "planned",
        },
        {
          title: "Phase 2 — check_vaulted_pm step + the playbook DB definition",
          why: "With the journey (Spec 1) and the guard (Phase 1) in place, the playbook is the DB-driven sequencer — a new check step plus rows, no new orchestration primitives.",
          what: "A check_vaulted_pm step type in playbook-executor (a data check like check_other_subscriptions), and the assisted-purchase playbook rows: check_vaulted_pm → if none, launch add_payment_method + await → create_order/create_subscription.",
          body: "Add a check_vaulted_pm step type to src/lib/playbook-executor.ts modeled on check_other_subscriptions / check_tracking ([[../libraries/playbook-executor]]) — reads customer_payment_methods, branches on has-vaulted-PM. Author the playbooks + playbook_steps rows (DB-driven, never hardcoded): step 1 check_vaulted_pm; if absent, launchJourneyForTicket('add_payment_method') and park; on the journey completion signal resume; final step create_order or create_subscription on the now-vaulted payment_method_id. Reuse the existing launch-journey + resume-after-journey path (cancel-playbook pattern) — no new await machinery. Cite the step-type registry + playbooks/playbook_steps.",
          verification: "Running the playbook for a customer with a vaulted PM skips straight to create. For a customer without one, it launches add_payment_method, parks, and on the journey's completion signal resumes and creates on the vaulted PM. Steps are DB rows (removing/reordering a row changes behavior — no hardcoding).",
          status: "planned",
        },
        {
          title: "Phase 3 — orchestrator trigger wiring (knowing when to use the playbook)",
          why: "A playbook is inert unless the orchestrator routes the right intent into it; this is the 'code implication' of a DB-defined playbook — teaching the orchestrator when to hand off.",
          what: "The orchestrator routes a purchase/reorder/add-subscription intent from a customer lacking a vaulted PM into the assisted-purchase playbook, rather than attempting a stateless create.",
          body: "Wire the trigger so a buy / reorder / 'add a subscription' intent selects the assisted-purchase playbook (DB trigger config where playbook selection lives; orchestrator prompt/tooling implication so it prefers the playbook over a bare create when a PM may be missing) ([[../libraries/action-executor]]). Confirm the resume-after-journey path lands back in the create step. Keep selection DB-driven where the framework allows. Cite the playbook-trigger mechanism + orchestrator routing.",
          verification: "A purchase-intent ticket from a customer with no vaulted PM enters the assisted-purchase playbook (not a stateless create). End-to-end: intent → check_vaulted_pm(none) → add_payment_method journey → completion → create fires on the vaulted PM. A customer with a PM still gets a direct create (no needless journey).",
          status: "planned",
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "retention#billing-integrity" },
  );
  console.log("spec 2 (assisted-purchase-playbook):", p ? "authored" : "FAILED");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
