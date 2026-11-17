/**
 * Author the "pre-renewal reminder + next-order management journey + self-running 50/50 test" GOAL +
 * MILESTONES via the goals-table SDK (never raw .from('goals')). Milestones only — Pia decomposes each
 * into specs after the CEO greenlights + hits Plan. Status = proposed.
 * Source: CFO-thread subscription-leakage review, 2026-11-16/17 (Dylan's direction).
 */
import "./_bootstrap";
import { upsertGoal, getGoal } from "../src/lib/goals-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906"; // Superfoods
const SLUG = "pre-renewal-reminder-next-order-journey";

async function main() {
  const existing = await getGoal(WS, SLUG);
  if (existing && existing.status !== "proposed") {
    throw new Error(`goal ${SLUG} already exists with status ${existing.status}; refusing to overwrite`);
  }
  const res = await upsertGoal(
    WS,
    {
      slug: SLUG,
      title: "Pre-renewal reminders + next-order journey, proven by a self-running 50/50 test",
      owner: "retention",
      proposer_function: "ceo",
      status: "proposed",
      why:
        "We have never told subscribers an order is coming (not under Appstle, not under Klaviyo). Customers who are overstocked or bored of a flavor find out when the charge hits, and they cancel: overstock is the top voluntary cancel reason, and voluntary cancels run about $15.8K MRR a month. A reminder could cut that churn and get customers trying other products, or it could remind people to cancel. We do not know which, so we must test it, and the test has to run itself because the CEO will not babysit it.",
      outcome:
        "A few days before each renewal, subscribers get an email (and a text if they opted in to SMS) that links to a next-order journey. That journey gives them the portal's subscription editor right inside the journey: swap flavor or product, change quantity, add an item, skip, change the date or frequency. Cancelling is possible there too, going through the same cancel flow and save offers as the portal. Reminders run as a 50/50 test at the customer level that assigns, guards, measures and reaches a verdict on its own, with a dashboard showing live results. The CEO is notified only when a guardrail trips or a verdict is reached.",
      success_metric:
        "Primary: 90-day net revenue per customer (charges minus refunds), reminder group vs holdout group, with a clear verdict. Secondary: voluntary cancel rate, skip rate, swap/add-on rate and number of distinct products ordered per customer. Operational: the test reaches its verdict with zero CEO interventions and no notifications other than guardrail trips and the verdict.",
      body: [
        "Direction from the CEO (2026-11-16/17, CFO thread):",
        "- The reminder links to a JOURNEY, not the portal. The journey delivers the portal's UI (the subscription editor) inside the journey, not linear journey steps, and makes swaps and flavor changes super simple.",
        "- The customer can cancel from inside the journey. That means the cancel saves and rebuttals have to be there too, not a bounce to the portal.",
        "- Hard rule: the Portal and the journey (mini-site) surfaces for cancels, saves and account management must stay in sync. Reuse the shared executors that already exist: src/lib/remedy-actions.ts (save offers), src/lib/remedy-selector.ts (offer picking, used by both cancel surfaces), src/lib/payment-recovery.ts (card fixes), and the commerce SDK src/lib/commerce/subscription.ts plus src/lib/subscription-items.ts (every edit; three-engine routing). Never fork a second copy.",
        "- Self-running experiment with a dashboard. Minimise notifications to the CEO: only critical guardrail trips and the final verdict.",
        "",
        "Starting assumptions (Pia and the specs may refine them; flag any change on the approval request):",
        "- Lead time about 5 days before next_billing_date, so the customer can act before the charge and before any Shopify contract cutoff. Respect quiet hours and the customer's timezone for SMS (see libraries/marketing-text-timezone).",
        "- Audience: every active subscription on both live engines (billing_source shopcx and internal). Skip a sub that is paused, in dunning, or already changed in the last few days. One reminder per customer per renewal, even with several subs. If two subs renew close together, combine them.",
        "- Email is transactional (Resend). SMS only to customers with SMS marketing consent (TCPA). STOP and unsubscribe are honoured and counted.",
        "- Assignment is sticky per customer (across all of a customer's linked accounts) and fixed at first eligibility. 50% get reminders, 50% are a true holdout that gets nothing new.",
        "- Guardrails that auto-pause the reminder arm and notify the CEO: treatment voluntary cancel rate significantly above holdout; complaint, spam or STOP rate above a ceiling; send failures or wrong-recipient sends; journey actions failing (an edit the customer made that did not land).",
        "- Verdict: run until the 90-day revenue window closes for a pre-registered sample size, then declare win, loss or no difference. On a win, recommend rolling out to 100% (the CEO approves the rollout). On a loss, stop.",
        "- North-star rules: every new cron, Inngest function and agent ships with an owner, a kill switch and a heartbeat. Every new table and library gets a brain page. Every journey action is verified before the customer is told it worked (no false 'your subscription is updated' messages, the 2026-11-16 save-flow bug class).",
        "",
        "Existing pieces to build on (gap-analyze before writing new): journeys (docs/brain/journeys, libraries/journey-delivery, journey-tokens, journey-step-builder, cancel-journey-builder); the customer portal (lifecycles/customer-portal, shopify-extension/portal-src and the mini-site portal build); the cancel flow (lifecycles/cancel-flow); email (libraries/email, email-tracking, integrations/resend); SMS (integrations/twilio, libraries/sms-marketing-agent, tables/sms_marketing_policy); the storefront experiment framework (libraries/storefront-experiments, tables/storefront_experiments and its variants). Decide whether the subscriber test reuses that framework or needs a lifecycle-experiment table of its own.",
        "",
        "## Decomposition",
        "- **M1 — Next-order journey.** The portal's subscription editor delivered inside a journey, with in-journey cancel and saves at parity with the portal.",
        "- **M2 — Renewal reminder sends.** Scheduled email + consented SMS before each renewal, linking into the M1 journey.",
        "- **M3 — Self-running 50/50 test.** Sticky assignment, holdout, guardrails, pre-registered verdict, CEO notified only on trips and the verdict.",
        "- **M4 — Results dashboard.** Live view of both arms, guardrails and the verdict.",
      ].join("\n"),
    },
    [
      {
        position: 1,
        title: "M1 — Next-order journey",
        why: "A reminder is only useful if acting on it is effortless. Today the portal has the editor but journeys only offer linear steps, and the CEO wants the journey surface, with no login, to be where customers manage their next order.",
        what: "A new journey type, opened from a tokenized link, that renders the portal's subscription editor UI: swap flavor or product, change quantity, add an item, skip, change the date or frequency, and see the next order total. Every edit goes through the same commerce SDK the portal uses and is verified before the customer sees success. Cancel is available in-journey and runs the same cancel flow, save offers and rebuttals as the portal (shared remedy selector and executor), so the two surfaces cannot drift. The journey also works standalone (for example linked from support tickets), not only from reminders.",
        body: "Build on the portal editor components (shopify-extension/portal-src, mini-site portal build: run node scripts/build-all-portals.js after edits) and the journey token and delivery plumbing. Parity check: every action available in the portal editor is available in the journey, through the same handler or SDK call. Track journey events (opened, edited, skipped, cancelled, saved) for M3.",
      },
      {
        position: 2,
        title: "M2 — Renewal reminder sends",
        why: "Customers are surprised by renewals because we never warn them. A short, on-brand heads-up lets them adjust before they are charged.",
        what: "A scheduled job finds subscriptions renewing in about 5 days and sends one reminder per customer per renewal: an email to everyone eligible and a text to those with SMS consent. Each message shows what is coming (items, date, price) and links into the M1 journey. Sends are tracked, de-duplicated, quiet-hours and timezone aware, flood-safe for the renewal wave, and send only to customers the M3 test puts in the reminder arm.",
        body: "Owner retention (Transactional & lifecycle messaging mandate). The cron or Inngest function ships with owner, kill switch and heartbeat. Templates live in the DB (journeys, remedies and coupons are DB-driven, never hardcoded). Honour STOP and unsubscribe. Skip paused subs, subs in dunning, and subs edited recently. Log every send with the experiment arm for attribution.",
      },
      {
        position: 3,
        title: "M3 — Self-running 50/50 test",
        why: "Reminders could cut churn and drive product exploration, or remind people to cancel. Only a clean holdout tells us which, and the CEO will forget about it, so it must run, protect itself and conclude on its own.",
        what: "Customers are assigned once, stickily (across linked accounts), 50% reminder and 50% holdout. Metrics are pre-registered: 90-day net revenue per customer as the primary, with cancel, skip, swap/add-on and product-variety rates as secondaries. Guardrails auto-pause the reminder arm and notify the CEO when tripped. At the planned sample size and window the test declares win, loss or no difference and notifies the CEO once, with a rollout recommendation that needs his approval. No other notifications.",
        body: "Supervisable-autonomy north star: the test optimizes a bounded proxy and the retention function owns the objective. Hitting a guardrail means escalate, not continue. Decide whether to reuse the storefront experiment framework (assignVariant banding, experiment tables) or add a subscriber/lifecycle experiment table with its own brain page. Power calculation and the stop rule are written down before launch.",
      },
      {
        position: 4,
        title: "M4 — Results dashboard",
        why: "The CEO wants to look in whenever he likes without being pinged, and see at a glance whether reminders are winning.",
        what: "A dashboard page showing both arms side by side: customers enrolled, reminders sent, journey opens and actions, cancels, skips, swaps and add-ons, products per customer, 90-day net revenue per customer with confidence intervals, guardrail status, and progress toward the verdict. Once concluded it shows the final verdict.",
        body: "Lives under the existing dashboard (retention). Follow the mobile-dashboard-design conventions. Data from the M2 send log, M1 journey events, orders and refunds, and M3 assignments.",
      },
    ],
  );
  console.log("Authored goal:", SLUG, res.goal_id);
  console.log("Milestone ids (position → id):", res.milestone_ids);
  const check = await getGoal(WS, SLUG);
  console.log("Verify:", check?.status, check?.owner, check?.milestones.map((m) => m.title));
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
