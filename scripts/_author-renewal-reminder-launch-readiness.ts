/**
 * Throwaway author script (CEO-commissioned 2026-11-22): the fix spec that must ship before the
 * pre-renewal reminder 50/50 test is launched. Runs once via `npx tsx`; idempotent on slug.
 */
import { loadEnv } from "./_bootstrap";
loadEnv();
import { authorSpecRowStructured } from "../src/lib/author-spec";
import { getSpec } from "../src/lib/specs-table";

const WORKSPACE_ID = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods Company
const SLUG = "renewal-reminder-launch-readiness";

const tsc = (p: number) => ({ position: p, description: "tsc clean on the branch", kind: "auto" as const, exec_kind: "tsc" as const, params: null });
const grep = (p: number, description: string, pattern: string, path: string, expect: "present" | "absent" = "present") =>
  ({ position: p, description, kind: "auto" as const, exec_kind: "grep" as const, params: { pattern, path, expect } });
const unit = (p: number, script: string) =>
  ({ position: p, description: `${script} passes`, kind: "auto" as const, exec_kind: "unit_test" as const, params: { script } });
const human = (p: number, description: string) =>
  ({ position: p, description, kind: "human" as const, exec_kind: "needs_human" as const, params: null });

async function main() {
  const ok = await authorSpecRowStructured(
    WORKSPACE_ID,
    SLUG,
    {
      title: "Renewal reminder launch readiness: journey/Portal parity, exact charge, clean metric, real guardrails",
      why:
        "The pre-renewal reminder goal shipped dormant, but a CEO launch review on 2026-11-22 found 10 gaps that make it unsafe to turn on. " +
        "The next-order journey skips the Portal's safety checks (Portal and journeys must stay in sync), three CEO requirements from 11/17 were not built " +
        "(exact charge in the reminder, net revenue without tax/shipping, auto-pause guardrails that notify the CEO), and the experiment's on/off status is ignored.",
      what:
        "When this ships, the next-order journey edits a subscription with exactly the Portal's catalog, prices and guards; the reminder shows the renewal date, items and exact charge; " +
        "the 50/50 test measures net merchandise revenue; sends only happen while the experiment status is 'running'; and a daily guardrail/verdict cron auto-pauses on harm and notifies the CEO once. " +
        "It does NOT launch the test: no experiment row is created by this spec. Launch stays a separate CEO-approved action.",
      summary:
        "Fixes the gaps in src/app/api/journey/[token]/edit/route.ts, src/lib/next-order-journey-builder.ts, src/lib/pre-renewal-reminders.ts, " +
        "src/lib/subscriber-experiments.ts, src/lib/subscriber-experiment-metrics.ts and src/lib/retention/reminder-results-sdk.ts, and builds the guardrail/verdict cron " +
        "left unbuilt by subscriber-experiment-guardrails-verdict Phases 2-3. See docs/brain/lifecycles/pre-renewal-reminder-journey.md.",
      owner: "retention",
      parent: '[[../functions/retention]] — "Churn prevention & win-back" mandate: makes the shipped pre-renewal reminder safe to launch.',
      blocked_by: [],
      human_review:
        "Before launch, Dylan previews a test reminder email + the next-order page on his own account and confirms the amount shown matches what his next renewal will charge. Also open a next-order journey for a test customer: Shipping Protection, Strawberry Lemonade Tabs and Cocoa Instant Coffee are not offered, prices match the Portal, and a frequency change leaves a sane next bill date.",
      phases: [
        {
          title: "Phase 1 — Next-order journey at Portal parity (catalog, prices, guards, frequency, failed-edit ticket)",
          why:
            "CEO rule: cancels, saves and account management exist on the Portal and in journeys and must stay in sync. Today the journey offers every product in the store " +
            "(including Shipping Protection, out-of-stock and suppressed variants), shows raw catalog prices, skips the Portal guards, and changes frequency without the next-bill-date roll-forward " +
            "that fixed the stranded-sub bug (Ashley Denson, 2026-10-08). Shipping Protection must never be treated as a product.",
          what:
            "The journey uses the SAME catalog, price quotes, guards and frequency logic as the Portal, through shared helpers both surfaces call. A failed edit from a ticketless reminder session opens a ticket for the customer.",
          body: [
            "Verified gaps (code on main 2026-11-22):",
            "1. Catalog. src/lib/next-order-journey-builder.ts:112-131 loads every `products` row + variant. The Portal (src/lib/portal/handlers/bootstrap.ts:112-200) limits to `portal_config.general.products_available_to_add`, drops suppressed variants (`getSuppressedVariantIds`) and out-of-stock variants, and treats `shipping_protection_product_ids` separately. " +
              "Extract that logic into a shared `loadEditableCatalog(workspaceId)` in a new src/lib/portal/editable-catalog.ts; call it from bootstrap.ts AND next-order-journey-builder.ts. Shipping Protection products/variants must never appear in the journey's swap/add list (by configured id, not only by the title keyword filter at next-order-journey-builder.ts:80).",
            "1b. CEO rule (2026-11-22): a customer can only swap or add INTO a consumable product that is in stock. Never Shipping Protection (product_type 'ShopWill' / handle 'shipping-insurance'), free-gift duplicates, the internal Mystery Item, or digital goods; never an out-of-stock variant. " +
              "Ground truth: Strawberry Lemonade Tabs and Cocoa Instant Coffee are out of stock today and must NOT be offered. Probe how those two are represented (inventory_quantity 0 vs null, suppressed variants, product status) and make the rule exclude them; the Portal's current filter treats inventory_quantity null as in stock, which may be how they leak. " +
              "Put this rule in `isSwappableConsumable(product, variant)` inside editable-catalog.ts, apply it to the Portal AND the journey lists, and enforce it server-side on swap/add in both surfaces (not just hidden in the UI).",
            "2. Prices. The journey shows `price_cents` list prices and a total summed from stored line prices (next-order-journey-builder.ts:129,148). Use the Portal's price-quote path (src/lib/portal/handlers/price-quote.ts → src/lib/pricing.ts `resolveSubscriptionPricing`) for line prices, swap/add previews and the subscription total. Expose a journey route for price quotes scoped to the session's (linked) subs, mirroring price-quote.ts.",
            "3. Frequency. src/lib/portal/handlers/frequency.ts:43-60 calls `subscriptionUpdateBillingInterval` THEN rolls `next_billing_date` forward by the new cadence (`rollForwardToFutureBillingDate`). The journey edit route (src/app/api/journey/[token]/edit/route.ts change_frequency case) only calls `subscriptionUpdateBillingInterval`. " +
              "Extract the Portal's full frequency sequence into a shared `changeSubscriptionFrequency(workspaceId, contractId, interval, intervalCount)` in a new src/lib/subscription-frequency.ts; call it from BOTH frequency.ts and the journey edit route. Normalize interval casing the way the Portal does.",
            "4. Guards. The Portal's checks live in its handlers, not the shared executors: `assertNewVariantsSelectable` (src/lib/portal/mutation-guard.ts:327, used by replace-variants.ts), `canMutateSubscription` (mutation-guard.ts:208), `shouldBlockForFailedPayment` (src/lib/portal/failed-payment-guard.ts, used by change-date.ts / frequency.ts), and the swap price guard (`decideSwapNewLineBaseCents` / swap-price-assertion). Apply the same checks in the journey edit route before dispatch, returning a customer-safe validation message (not a 'team will handle it' failure).",
            "5. Failed edit with no ticket. Reminder sessions are minted with `ticket_id` null (src/lib/pre-renewal-reminders.ts sendTreatmentReminder). `raiseFailedEdit` in the edit route then only writes a dashboard notification with a session id, yet tells the customer 'our team will take care of it'. Add `ensureJourneyFollowUpTicket(admin, session)` that creates (or reuses) a ticket for the session's customer, stamps it on journey_sessions.ticket_id, and is used by raiseFailedEdit/failUnresolved so a human always owns the promise. Include customer id + subscription id in the notification metadata.",
            "6. Read the existing spec-test result for the `next-order-journey-editor` spec (verdict=issues) and fix whatever regression it names if it is still real on main.",
            "Update docs/brain/journeys/next-order.md (the 'portal mutation guards intact' claim was wrong; document the shared helpers) and add brain pages for the two new library files (docs/brain/libraries/editable-catalog.md, docs/brain/libraries/subscription-frequency.md).",
          ].join("\n"),
          verification: [
            "- `npx tsc --noEmit` clean.",
            "- `loadEditableCatalog` present in next-order-journey-builder.ts and bootstrap.ts.",
            "- `changeSubscriptionFrequency` present in the journey edit route and the Portal frequency handler.",
            "- `assertNewVariantsSelectable` and `shouldBlockForFailedPayment` present in the journey edit route.",
            "- `ensureJourneyFollowUpTicket` present in the journey edit route.",
          ].join("\n"),
          status: "planned",
          checks: [
            tsc(1),
            grep(2, "journey builder uses the shared Portal catalog", "loadEditableCatalog", "src/lib/next-order-journey-builder.ts"),
            grep(3, "Portal bootstrap uses the shared catalog", "loadEditableCatalog", "src/lib/portal/handlers/bootstrap.ts"),
            grep(10, "consumable + in-stock rule exists", "isSwappableConsumable", "src/lib/portal/editable-catalog.ts"),
            grep(11, "journey enforces the rule server-side", "isSwappableConsumable", "src/app/api/journey/[token]/edit/route.ts"),
            grep(4, "journey frequency goes through the shared sequence", "changeSubscriptionFrequency", "src/app/api/journey/[token]/edit/route.ts"),
            grep(5, "Portal frequency goes through the shared sequence", "changeSubscriptionFrequency", "src/lib/portal/handlers/frequency.ts"),
            grep(6, "journey applies the selectability guard", "assertNewVariantsSelectable", "src/app/api/journey/[token]/edit/route.ts"),
            grep(7, "journey applies the failed-payment guard", "shouldBlockForFailedPayment", "src/app/api/journey/[token]/edit/route.ts"),
            grep(8, "failed edits get a follow-up ticket", "ensureJourneyFollowUpTicket", "src/app/api/journey/[token]/edit/route.ts"),
          ],
        },
        {
          title: "Phase 2 — Reminder shows the renewal date, items and exact charge",
          why:
            "CEO requirement (2026-11-17): the reminder must show exactly what will be charged, from the pricing engine, before billing. Today the email (src/lib/pre-renewal-reminders.ts sendTreatmentReminder) is a generic 'review your next order' line with no date, items or amount.",
          what:
            "The reminder email and SMS state the renewal date, the items (excluding Shipping Protection lines, which are not products) and the exact amount the renewal will charge. If the amount cannot be resolved exactly, the reminder omits it rather than showing a guess.",
          body: [
            "Add `reminderChargePreview(workspaceId, subscriptionId)` in src/lib/pre-renewal-reminders.ts that returns { nextBillingDate, items[], amountCents | null } using the SAME computation the renewal charge uses for that engine " +
              "(internal: src/lib/pricing.ts `resolveSubscriptionPricing` + the renewal worker's tax/shipping logic; shopcx engine: the contract-line pricing the shopcx renewal path bills). Do not re-implement pricing. " +
              "When a person has several in-window subs (group collapse), show each sub's date + amount.",
            "Render it in the email via `sendJourneyCTA` contextMessage (or a dedicated template if contextMessage can't carry a line-item block). Keep the SMS short: date + amount + link. Plain text, no markdown (CLAUDE.md AI-response rule applies to SMS).",
            "Stamp the previewed amount on the pre_renewal_reminders ledger row (new nullable column `previewed_amount_cents` via migration) so a mismatch with the actual renewal charge can be audited.",
            "Update docs/brain/libraries/pre-renewal-reminders.md and docs/brain/tables/pre_renewal_reminders.md.",
          ].join("\n"),
          verification: ["- tsc clean.", "- `reminderChargePreview` present in src/lib/pre-renewal-reminders.ts.", "- test:pre-renewal-reminders passes."].join("\n"),
          status: "planned",
          checks: [
            tsc(1),
            grep(2, "charge preview helper exists", "reminderChargePreview", "src/lib/pre-renewal-reminders.ts"),
            grep(3, "previewed amount stamped on the ledger", "previewed_amount_cents", "src/lib/pre-renewal-reminders.ts"),
            unit(4, "test:pre-renewal-reminders"),
          ],
        },
        {
          title: "Phase 3 — Net revenue excludes tax and shipping; only paid orders count",
          why:
            "CEO requirement (2026-11-17): the primary metric is 90-day net revenue per customer EXCLUDING tax and shipping. src/lib/subscriber-experiment-metrics.ts sums `orders.total_cents`, which includes both, and counts orders regardless of payment status.",
          what:
            "Each arm's revenue is net merchandise revenue (item revenue after discounts, minus settled refunds of merchandise), and only paid orders count.",
          body: [
            "Add an exported `netMerchandiseCents(order)` in src/lib/subscriber-experiment-metrics.ts and use it instead of `total_cents`. Probe `public.orders` first (probe-db skill) for the real tax/shipping/subtotal/discount columns — " +
              "`avalara_total_tax_cents` exists; `payment_details` carries subtotal/tax/shipping/discount only for checkout orders (null on renewals, see docs/brain/tables/orders.md), so derive renewal merchandise from line_items or the columns the renewal writer sets. " +
              "Exclude orders whose financial status is not paid (probe the real status values). Refund netting stays settled-only; exclude the shipping/tax portion where refund rows carry it.",
            "Keep reminder-results-sdk.ts labels honest ('net merchandise revenue'). Update docs/brain/libraries/subscriber-experiment-metrics.md.",
          ].join("\n"),
          verification: ["- tsc clean.", "- `netMerchandiseCents` present.", "- test:reminder-results-sdk passes."].join("\n"),
          status: "planned",
          checks: [
            tsc(1),
            grep(2, "metric uses net merchandise revenue", "netMerchandiseCents", "src/lib/subscriber-experiment-metrics.ts"),
            unit(3, "test:reminder-results-sdk"),
          ],
        },
        {
          title: "Phase 4 — Experiment status is the real on/off switch",
          why:
            "CEO requirement: rollout needs CEO approval. Today `assignArm` (src/lib/subscriber-experiments.ts) acts on ANY experiment row: a 'draft' row starts sends, and 'stopped'/'complete' does not stop them. The harness kill switch only blocks NEW assignments, so existing treatment people keep getting reminders.",
          what:
            "Reminders go out only while the experiment status is 'running'. 'draft' sends nothing; 'stopped' or 'complete' stops ALL further reminders (new and existing assignees). Launch = a CEO-approved status flip to 'running'.",
          body: [
            "Add `isExperimentRunning(experiment)` to src/lib/subscriber-experiments.ts. `assignArm` returns null unless running. In src/lib/pre-renewal-reminders.ts `runPreRenewalRemindersForWorkspace`, fetch the experiment once and skip the workspace entirely unless running (cheap no-op, still heartbeats).",
            "Add `setExperimentStatus(workspaceId, slug, status, { by, reason })` as the only writer of status (SDK chokepoint), recording who/why. createExperiment keeps defaulting to 'draft'.",
            "Do NOT create the pre-renewal-reminder experiment row in this spec or any migration/backfill. Update docs/brain/libraries/subscriber-experiments.md + the lifecycle page's launch-gate wording.",
          ].join("\n"),
          verification: ["- tsc clean.", "- `isExperimentRunning` present in both files.", "- test:subscriber-experiments + test:pre-renewal-reminders pass."].join("\n"),
          status: "planned",
          checks: [
            tsc(1),
            grep(2, "status gate in the harness", "isExperimentRunning", "src/lib/subscriber-experiments.ts"),
            grep(3, "status gate in the reminder run", "isExperimentRunning", "src/lib/pre-renewal-reminders.ts"),
            grep(4, "single status writer", "setExperimentStatus", "src/lib/subscriber-experiments.ts"),
            unit(5, "test:subscriber-experiments"),
            unit(6, "test:pre-renewal-reminders"),
          ],
        },
        {
          title: "Phase 5 — Guardrail + verdict cron: auto-pause on harm, notify the CEO once",
          why:
            "CEO requirement (2026-11-17): the test is self-running and the CEO hears about it only on a critical guardrail trip or the final verdict. subscriber-experiment-guardrails-verdict Phases 2-3 were never built (the lifecycle page lists them as open work); today the dashboard only shows a derived 'watch' label and nothing pauses or notifies.",
          what:
            "A daily retention-owned cron evaluates guardrails with a sequential-safe test; on a trip it flips the experiment to 'stopped' (which, after Phase 4, halts all reminders) and sends ONE deduped CEO notification with the reasoning. When the pre-registered sample is reached and every group's 90-day window has closed, it records the verdict and notifies the CEO once.",
          body: [
            "New Inngest fn src/lib/inngest/subscriber-experiment-guardrails.ts, id `subscriber-experiment-guardrail-cron`, daily (>=5 min cadence; 30h liveness window per CLAUDE.md monitor-cadence invariant). Register it in src/lib/inngest/registered-functions.ts and as a `retention`-owned MONITORED_LOOPS row in src/lib/control-tower/registry.ts with a kill_switches ancestry, and `emitCronHeartbeat` on every tick (node-completeness hard rule).",
            "Guardrails (treatment vs holdout): voluntary cancel rate, refund rate, SMS STOP opt-out rate, email unsubscribe/complaint rate (from email_events if available), and net merchandise revenue per person. Use a sequential-safe method (e.g. an always-valid / mSPRT boundary or an alpha-spending boundary), NOT repeated naive p-values, so daily peeking does not inflate false trips. Also trip on hard absolute floors (e.g. STOP or complaint spikes) regardless of significance.",
            "On trip: `setExperimentStatus(..., 'stopped', { by: 'guardrail', reason })`, then insert ONE dashboard_notifications row for the CEO (dedupe key per experiment + guardrail), with the numbers and the reasoning (north star: escalate, don't execute silently). Never auto-resume.",
            "Verdict: when both arms reach `required_n_per_arm` and every assignment's 90-day window has closed, compute the verdict on the primary metric, persist it (status 'complete' + verdict fields via the SDK), notify the CEO once. Replace `deriveGuardrails`/`deriveVerdict` in src/lib/retention/reminder-results-sdk.ts with the persisted results (keep derived as fallback only before the first evaluation).",
            "Brain: docs/brain/inngest/subscriber-experiment-guardrails.md, update the lifecycle page's Status / open work block and docs/brain/dashboard/retention-renewal-reminder.md.",
          ].join("\n"),
          verification: [
            "- tsc clean.",
            "- registry has `subscriber-experiment-guardrail-cron`.",
            "- the new inngest file emits `emitCronHeartbeat`.",
            "- test:subscriber-experiments + test:reminder-results-sdk pass.",
          ].join("\n"),
          status: "planned",
          checks: [
            tsc(1),
            grep(2, "cron registered under retention", "subscriber-experiment-guardrail-cron", "src/lib/control-tower/registry.ts"),
            grep(3, "cron heartbeats", "emitCronHeartbeat", "src/lib/inngest/subscriber-experiment-guardrails.ts"),
            grep(4, "trip pauses via the status SDK", "setExperimentStatus", "src/lib/inngest/subscriber-experiment-guardrails.ts"),
            unit(5, "test:subscriber-experiments"),
            unit(6, "test:reminder-results-sdk"),
          ],
        },
      ],
    },
    "planned",
    { intendedStatusSetBy: "ceo", parentKind: "mandate", parentRef: "retention#churn-prevention-win-back" },
  );
  console.log(ok ? "authored" : "author write failed");
  const s = await getSpec(WORKSPACE_ID, SLUG);
  console.log(JSON.stringify({ slug: s?.slug, status: (s as { status?: string } | null)?.status, owner: (s as { owner?: string } | null)?.owner, phases: (s as { phases?: unknown[] } | null)?.phases?.length }, null, 2));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
