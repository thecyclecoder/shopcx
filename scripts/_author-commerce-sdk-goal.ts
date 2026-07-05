/**
 * Author the "Centralized Commerce SDK" goal + milestone tree into public.goals /
 * public.goal_milestones via the goals-table SDK (upsertGoal — never raw .from).
 *
 * status='proposed' → the CEO (Dylan) greenlights in ShopCX, then hits Plan so Pia
 * (the plan agent) decomposes each milestone into specs. This script authors the
 * GOAL + MILESTONES only; it does NOT author specs.
 *
 * Idempotent: re-running REPLACE-by-position preserves milestone ids (so any specs
 * Pia later attaches don't unlink). Refuses to clobber if the goal is already
 * greenlit/complete.
 *
 * Run: npx tsx scripts/_author-commerce-sdk-goal.ts        (dry run — prints plan)
 *      APPLY=1 npx tsx scripts/_author-commerce-sdk-goal.ts (writes)
 */
import "./_bootstrap";
import { getGoal, upsertGoal, type GoalMilestoneInput } from "../src/lib/goals-table";

const WS = "fdc11e10-b89f-4989-8b73-ed6526c4d906";
const SLUG = "centralized-commerce-sdk";
const APPLY = process.env.APPLY === "1";

const REF = "docs/brain/reference/commerce-sdk-inventory.html";

const OUTCOME =
  "Every customer-facing surface — the dashboard, both customer portals, and the AI stack — reads and " +
  "writes commerce entities (subscriptions, orders, returns, replacements, customers, loyalty, chargebacks, " +
  "fraud, crisis) through ONE `src/lib/commerce` SDK: entity-named, internal-vs-Appstle-aware, gateway-aware, " +
  "and pricing-resolved. No surface queries the DB directly for a commerce entity, and no surface ever touches " +
  "raw `items[].price_cents`.";

const WHY =
  "We introduced internal subscriptions/orders after Appstle, and today customer data is read/written through " +
  "THREE unshared data stacks (dashboard REST routes · portal handlers · AI directActionHandlers) that each " +
  "re-implement — or skip — the internal-vs-Appstle branch. That is a live bug class: phantom refunds on " +
  "Braintree-paid orders, coupon actions that mis-fire on internal subs, $0/$NaN pricing in viewers, and dead " +
  "direct actions. Centralizing removes the whole class and unblocks the Appstle + Shopify sunset. Full " +
  `nav-driven inventory (surfaces · Display+Mutation ops · defect register · build plan): ${REF}.`;

const SUCCESS =
  "Zero direct commerce `.from()` reads/writes remain in customer-facing surfaces; the differential harness " +
  "shows zero $NaN/$0 across internal + Appstle + grandfathered samples and parity with today's correct " +
  "outputs; every `appstleX` fn renamed to `subscriptionX`; the two critical money bugs (phantom refund, " +
  "coupon mis-fire) closed; the customer portal is migrated LAST and diff-verified.";

const BODY = `# Centralized Commerce SDK

One internal-aware SDK for every customer-facing read and write. Motivated by two one-off bugs (a next-order
date set via raw Shopify GraphQL instead of the internal-aware dispatcher; a correct date rendered a day early)
that turned out to be one systemic gap.

**Full research inventory:** \`${REF}\` — the nav-driven surface map, the Display + Mutation operation set, the
canonical view shapes, the \`appstleX → subscriptionX\` rename map, the 9-item defect register, and the build
plan. (Open the HTML locally; it is self-contained.)

## The structural finding
Mutations are ~70% converged (AI/Improve/Triage share \`directActionHandlers\`; portal + AI dispatch through the
\`appstle.ts\` / \`subscription-items.ts\` wrappers). **Reads are not unified at all**, and pricing-enrichment
(the \`$NaN\` guard) is applied inconsistently across the three stacks. Target: all three become thin consumers
of one \`src/lib/commerce\` SDK.

## Invariants the SDK guarantees
- **One money resolver.** \`priceSubscription\` is the only path to a line/total price; internal subs can never
  emit \`undefined\` cents, so no surface can render \`$NaN\`/\`$0\`.
- **Every mutation dispatches internal-vs-Appstle** (and, for money, is gateway-aware: Braintree vs Shopify).
- **SQL/RPC for anything list-or-aggregate** (a prior session cut a 3h job to 8s this way).
- **No silent truncation** — list ops paginate past the 1000-row cap.

## Milestones = the build plan
The milestones below are the sequenced build plan (SDK built + battle-tested in isolation → internal surfaces
migrated → customer portal LAST, diff-verified). Pia decomposes each milestone into specs at Plan time.
`;

const MILESTONES: GoalMilestoneInput[] = [
  {
    position: 1,
    title: "M1 — Stop the bleeding: the two critical money bugs",
    why:
      "Two defects harm money/customers RIGHT NOW and must not wait for a multi-week refactor: the only live " +
      "refund button fires Shopify `returnProcess` with no gateway check (phantom refunds on Braintree-paid " +
      "orders), and the subscription coupon route (apply + remove) never branches internal-vs-Appstle (mis-fires " +
      "on internal contracts).",
    what:
      "Returns 'Issue Refund' routes through the gateway-aware path (Braintree vs Shopify auto-picked); the " +
      "subscription coupon route dispatches internal-vs-Appstle for both apply and remove. Shipped as targeted " +
      "internal-aware fixes (same shape as the already-fixed `changeNextBillingDate` bug) that seed the SDK.",
    body:
      "Defects #1 + #2 in the register. Wire `partialRefundByAmount`/`refundOrderViaBraintree` into the returns " +
      "refund flow; make `subscriptions/[subId]/coupon` (POST + DELETE) and the AI `apply_coupon`/`remove_coupon` " +
      "handlers call the internal-aware dispatcher. Reference: " + REF + ".",
  },
  {
    position: 2,
    title: "M2 — SDK core: Display + Mutation, zero consumers",
    why:
      "Build the correct layer in isolation so production is byte-for-byte untouched until it is proven. Building " +
      "against a partial operation set is the one expensive mistake — the contract inventory is the acceptance spec.",
    what:
      "`src/lib/commerce` exposes `listX`/`detailX` returning fully enriched, pricing-resolved, internal-vs-Appstle-" +
      "normalized view shapes (SubscriptionView, OrderView, CustomerView, …) with `priceSubscription` as the only " +
      "price path, plus entity-named internal-aware mutations. The `appstleX → subscriptionX` renames land here. " +
      "Nothing imports it yet.",
    body:
      "Display + Mutation operation sets and the rename map are enumerated in the inventory (" + REF + "). No " +
      "surface changes in this milestone — the SDK ships with zero consumers.",
  },
  {
    position: 3,
    title: "M3 — Battle-test harness + performance",
    why:
      "Prove parity and kill the perf/egress/1000-row/NaN risks BEFORE any surface swaps — the whole 'don't break " +
      "what customers see' guarantee lives here.",
    what:
      "A differential harness diffs new-SDK output against current portal + dashboard output for the same entity " +
      "across internal / Appstle / grandfathered samples; NaN assertions fail on any non-finite field; egress + " +
      "latency + row-count benchmarks; SQL RPCs for the JS-aggregation hotspots (ranked: Funnel ≫ MRR > Portal-" +
      "analytics > Dunning).",
    body: "Runs entirely locally against read-only prod data. Reference: " + REF + ".",
  },
  {
    position: 4,
    title: "M4 — Migrate internal surfaces (dashboard + agent + AI)",
    why:
      "Lowest blast-radius first; every surface here is seen by the team before any customer, so regressions are " +
      "caught internally. Also the place to close the missing-action gaps and the crisis-resolve stub.",
    what:
      "Dashboard lists → detail pages → the ticket mega-page → orchestrator/improve/triage move onto the SDK, each " +
      "diff-verified behind an unchanged UI. Fix the missing actions (sub-detail apply-coupon; ticket-page change-" +
      "frequency / line-items / payment-method) and the crisis 'Resolve' stub while here.",
    body:
      "Ticket detail is the highest-value single target (union of every read + mutation, all raw fetch, none " +
      "internal-aware today). Reference: " + REF + ".",
  },
  {
    position: 5,
    title: "M5 — Migrate the customer portal (LAST)",
    why:
      "The portal is the only true customer-eyeball surface. It migrates only after the SDK has run in production " +
      "on every internal surface and is diff-verified against the portal's own current output.",
    what:
      "Both portal render surfaces (in-house Next.js `app/portal/[slug]` + the Shopify extension) and the ~40 " +
      "shared `src/lib/portal/handlers/*` move onto the SDK. After this, the three stacks are one.",
    body: "Final domino. Reference: " + REF + ".",
  },
];

async function main() {
  const existing = await getGoal(WS, SLUG);
  if (existing && existing.status && existing.status !== "proposed") {
    console.error(`Goal ${SLUG} exists with status '${existing.status}' — refusing to reset. Aborting.`);
    process.exit(1);
  }

  console.log(`Goal: ${SLUG}  (owner=platform, proposer=platform, status=proposed)`);
  console.log(`Milestones: ${MILESTONES.length}`);
  for (const m of MILESTONES) console.log(`  ${m.position}. ${m.title}`);
  console.log(`Reference stashed: ${REF}`);

  if (!APPLY) {
    console.log("\nDRY RUN — set APPLY=1 to write.");
    return;
  }

  const res = await upsertGoal(
    WS,
    {
      slug: SLUG,
      title: "Centralized Commerce SDK — one internal-aware layer for every customer-facing read & write",
      body: BODY,
      outcome: OUTCOME,
      success_metric: SUCCESS,
      owner: "platform",
      proposer_function: "platform",
      parent_goal_id: null,
      is_parent: false,
      status: "proposed",
      why: WHY,
    },
    MILESTONES,
  );
  console.log(`\nWrote goal ${res.goal_id}`);
  console.log("Milestone ids:", JSON.stringify(res.milestone_ids));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
